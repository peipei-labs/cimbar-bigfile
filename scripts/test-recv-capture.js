'use strict';
// Run: node --test scripts/test-recv-capture.js
// Exercise the receiver's capture code with controlled browser callbacks and frames.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(process.env.RECV_SOURCE || path.join(__dirname, '..', 'recv.html'), 'utf8');
const captureSource = html.slice(html.indexOf('// ============= 采集:'), html.indexOf('function setVideoHint('));
assert.ok(captureSource.length > 0, 'receiver capture source must be present');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function frame(options = {}) {
  const format = options.format || 'RGBA';
  const rect = options.rect || { x: 0, y: 0, width: 4, height: 4 };
  return {
    format, visibleRect: rect,
    displayWidth: options.displayWidth || rect.width,
    displayHeight: options.displayHeight || rect.height,
    rotation: options.rotation || 0, flip: options.flip || false,
    closed: false, copied: false,
    allocationSize(copyOptions) {
      this.options = copyOptions;
      return options.size ?? rect.width * rect.height * (format === 'RGBA' ? 4 : 1.5);
    },
    async copyTo(pixels, copyOptions) {
      this.copied = true;
      if (options.wait) await options.wait;
      pixels.fill(42);
      return options.layout || copyOptions.layout;
    },
    close() { this.closed = true; },
  };
}

function harness(options = {}) {
  const videoCallbacks = new Map(), animationCallbacks = new Map(), timers = new Map();
  const cancelledVideo = [], cancelledAnimation = [], workers = [], decoded = [];
  let videoId = 0, animationId = 0, timerId = 0;
  let currentFrame = frame();
  function stream() {
    const track = { stopped: false, listeners: {}, stop() { this.stopped = true; },
      addEventListener(name, fn) { this.listeners[name] = fn; } };
    return { track, getTracks: () => [track], getVideoTracks: () => [track] };
  }
  const video = {
    readyState: 2, videoWidth: 4, videoHeight: 4, srcObject: null,
    play: async () => {},
    requestVideoFrameCallback(fn) { const id = videoId++; videoCallbacks.set(id, fn); return id; },
    cancelVideoFrameCallback(id) { cancelledVideo.push(id); videoCallbacks.delete(id); },
  };
  if (options.fallback) delete video.requestVideoFrameCallback;
  class Worker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage({ data }); }
  }
  const context = vm.createContext({
    State: { capturing: false, stream: null, capture: null, framesSeen: 0, queueDrops: 0, extractFails: 0 },
    wasmReady: true, WORKER_COUNT: 1, WORKER_URL: 'test-worker', MODE_B: 68, FRAMES_IN_FLIGHT_LIMIT: 20,
    Worker, VideoFrame: function () { return currentFrame; },
    Uint8Array, Date, console: { log() {}, warn() {}, error() {} },
    navigator: { mediaDevices: {
      getUserMedia: options.getUserMedia || (async () => stream()),
      getDisplayMedia: async () => stream(),
    } },
    document: { createElement: () => ({ getContext: () => ({
      drawImage() {}, getImageData: (_x, _y, w, h) => ({ data: new Uint8Array(w * h * 4) }),
    }) }) },
    $: () => video, log() {}, setVideoHint() {}, updateUiState() {},
    Sink: { onDecode: bytes => decoded.push(bytes) },
    requestAnimationFrame(fn) { const id = animationId++; animationCallbacks.set(id, fn); return id; },
    cancelAnimationFrame(id) { cancelledAnimation.push(id); animationCallbacks.delete(id); },
    setTimeout(fn) { const id = timerId++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(captureSource + `
    globalThis.api = { startCapture, stopCapture, scheduleNextFrame,
      copyVideoFrame: typeof copyVideoFrame === 'function' ? copyVideoFrame : null,
      initWorkers,
      get inFlight() { return _framesInFlight; } };
  `, context);
  context.api.initWorkers();
  if (!options.unready) workers[0].emit({ type: 'startWasm', ready: true });
  function fire(callbacks) {
    assert.equal(callbacks.size, 1, 'exactly one callback must be scheduled');
    const [id, fn] = callbacks.entries().next().value;
    callbacks.delete(id);
    fn(10);
  }
  return { api: context.api, state: context.State, video, workers, decoded, stream,
    videoCallbacks, animationCallbacks, timers, cancelledVideo, cancelledAnimation,
    setFrame(value) { currentFrame = value; },
    fireVideo: () => fire(videoCallbacks), fireAnimation: () => fire(animationCallbacks),
    fireWatchdog: () => fire(timers),
  };
}

test('stop cancels video callback id zero with the matching API', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  assert.equal(h.videoCallbacks.size, 1);
  h.api.stopCapture(false);
  assert.deepEqual(h.cancelledVideo, [0]);
  assert.deepEqual(h.cancelledAnimation, []);
  assert.equal(h.videoCallbacks.size, 0);
  assert.equal(h.timers.size, 0);
});

test('scheduling keeps a single pending callback', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  h.api.scheduleNextFrame();
  assert.equal(h.videoCallbacks.size, 1);
  assert.equal(h.timers.size, 1);
});

test('stop cancels a fallback animation callback', async () => {
  const h = harness({ fallback: true });
  await h.api.startCapture('screen');
  h.api.stopCapture(false);
  assert.deepEqual(h.cancelledAnimation, [0]);
  assert.deepEqual(h.cancelledVideo, []);
  assert.equal(h.animationCallbacks.size, 0);
});

test('watchdog retires the old video callback before scheduling fallback', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  const stale = h.videoCallbacks.values().next().value;
  h.fireWatchdog();
  assert.deepEqual(h.cancelledVideo, [0]);
  assert.equal(h.videoCallbacks.size, 0);
  assert.equal(h.animationCallbacks.size, 1);
  stale(20);
  await flush();
  assert.equal(h.workers[0].messages.length, 0);
  assert.equal(h.animationCallbacks.size, 1);
  h.fireAnimation();
  assert.equal(h.workers[0].messages.length, 1);
});

for (const restart of [false, true]) {
  test(`copy finishing after stop is discarded (restart=${restart})`, async () => {
    const wait = deferred();
    const f = frame({ wait: wait.promise });
    const h = harness();
    h.setFrame(f);
    await h.api.startCapture('camera');
    h.fireVideo();
    assert.equal(f.copied, true);
    assert.equal(h.timers.size, 0, 'watchdog only waits for a callback, not a copy');
    h.api.stopCapture(false);
    if (restart) await h.api.startCapture('camera');
    wait.resolve();
    await flush();
    assert.equal(f.closed, true);
    assert.equal(h.workers[0].messages.length, 0);
    assert.equal(h.videoCallbacks.size, restart ? 1 : 0);
  });
}

test('a queued callback from a stopped session leaves the new session intact', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  const stale = h.videoCallbacks.values().next().value;
  h.api.stopCapture(false);
  await h.api.startCapture('camera');
  stale(20);
  await flush();
  assert.equal(h.workers[0].messages.length, 0);
  assert.equal(h.videoCallbacks.size, 1);
});

test('late worker results are discarded while the next session can decode', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  h.fireVideo();
  await flush();
  h.api.stopCapture(false);
  await h.api.startCapture('camera');
  h.fireVideo();
  await flush();
  assert.equal(h.api.inFlight, 2);
  h.workers[0].emit({ buff: new Uint8Array([1]) });
  assert.equal(h.decoded.length, 0);
  h.workers[0].emit({ buff: new Uint8Array([2]) });
  assert.equal(h.decoded.length, 1);
  assert.equal(h.api.inFlight, 0);
});

test('only initialized workers receive frames', async () => {
  const h = harness({ unready: true });
  await h.api.startCapture('camera');
  h.fireVideo();
  await flush();
  assert.equal(h.api.inFlight, 0);
  assert.equal(h.workers[0].messages.length, 0);
  h.workers[0].emit({ type: 'startWasm', ready: true });
  h.fireVideo();
  await flush();
  assert.equal(h.workers[0].messages.length, 1);
  h.workers[0].onerror(new Error('worker failed'));
  assert.equal(h.api.inFlight, 0);
  assert.equal(h.workers[0].terminated, true);
});

for (const format of ['RGBA', 'NV12', 'I420']) {
  test(`${format} frames retain their copied format, crop and tight layout`, async () => {
    const h = harness();
    const f = frame({ format, rect: { x: 2, y: 2, width: 4, height: 4 } });
    const result = await h.api.copyVideoFrame(f);
    assert.equal(result.format, format);
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
    assert.equal(result.pixels.length, format === 'RGBA' ? 64 : 24);
    assert.deepEqual(f.options.rect, f.visibleRect);
    const expected = format === 'RGBA' ? [[0, 16]] : format === 'NV12'
      ? [[0, 4], [16, 4]] : [[0, 4], [16, 2], [20, 2]];
    assert.deepEqual(Array.from(f.options.layout, p => [p.offset, p.stride]), expected);
  });
}

for (const [name, options] of [
  ['scaled display', { displayWidth: 8 }],
  ['BGRA conversion', { format: 'BGRA' }],
  ['odd YUV dimensions', { format: 'NV12', rect: { x: 0, y: 0, width: 3, height: 3 } }],
  ['rotated frame', { rotation: 90 }],
  ['flipped frame', { flip: true }],
  ['unexpected allocation', { size: 80 }],
  ['unexpected stride', { layout: [{ offset: 0, stride: 20 }] }],
]) {
  test(`${name} uses canvas RGBA pixels with matching dimensions`, async () => {
    const h = harness();
    const f = frame(options);
    h.setFrame(f);
    await h.api.startCapture('camera');
    h.fireVideo();
    await flush();
    const msg = h.workers[0].messages[0];
    assert.equal(msg.format, 'RGBA');
    assert.equal(msg.pixels.length, msg.width * msg.height * 4);
    assert.equal(msg.width, h.video.videoWidth);
    assert.equal(msg.height, h.video.videoHeight);
    assert.equal(f.closed, true);
    assert.equal(h.videoCallbacks.size, 0);
    assert.equal(h.animationCallbacks.size, 1);
  });
}

test('a rejected pixel copy switches to one fallback loop', async () => {
  const wait = deferred();
  const h = harness();
  const f = frame({ wait: wait.promise });
  h.setFrame(f);
  await h.api.startCapture('camera');
  h.fireVideo();
  wait.reject(new Error('copy unavailable'));
  await flush();
  assert.equal(h.workers[0].messages.length, 1);
  assert.equal(h.animationCallbacks.size, 1);
  assert.equal(f.closed, true);
});

test('a stopped pending permission request releases its eventual stream', async () => {
  const wait = deferred();
  const h = harness({ getUserMedia: () => wait.promise });
  const starting = h.api.startCapture('camera');
  h.api.stopCapture(false);
  const s = h.stream();
  wait.resolve(s);
  await starting;
  assert.equal(s.track.stopped, true);
  assert.equal(h.state.capturing, false);
  assert.equal(h.videoCallbacks.size, 0);
});

test('an old stream ending cannot stop its replacement', async () => {
  const h = harness();
  await h.api.startCapture('camera');
  const oldStream = h.state.stream;
  await h.api.startCapture('camera');
  oldStream.track.listeners.ended();
  assert.equal(h.state.capturing, true);
  assert.equal(h.videoCallbacks.size, 1);
});
