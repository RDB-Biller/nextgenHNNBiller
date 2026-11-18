'use strict';
/**
 * Robot programs for the Hardware Developer pack. No dependencies.
 *  - Two robot shapes: a hobby-servo arm (base, shoulder, elbow, wrist and gripper) and a two-wheel rover.
 *  - A program is a short list of steps (move, reach a point, grip, wait, repeat). Dry Run checks every angle against the
 *    joint limits you set, then plays the program in a simulation before any code is written.
 *  - Code comes out for Arduino or ESP32 (C++), Raspberry Pi Pico (MicroPython), Raspberry Pi (Python) and ROS 2.
 * Safe by design: every angle is clamped to its limit in the generated code too, moves are ramped, and an optional stop button halts the robot.
 * The simulation uses the link lengths you give. It does not model weight, torque, or collisions with anything but the table.
 */
const zlib = require('zlib');
const { err } = require('./util');
const DEG = Math.PI / 180, r1 = (n) => Math.round(n * 10) / 10, r2 = (n) => Math.round(n * 100) / 100;
const BRAINS = { arduino: { label: 'Arduino', lang: 'cpp' }, esp32: { label: 'ESP32', lang: 'cpp' }, pico: { label: 'Raspberry Pi Pico (MicroPython)', lang: 'py' }, rpi: { label: 'Raspberry Pi (Python)', lang: 'py' }, ros2: { label: 'ROS 2', lang: 'py' } };
const PINS = { arduino: [3, 5, 6, 9, 10], esp32: [13, 12, 14, 27, 26], pico: [10, 11, 12, 13, 14], rpi: [17, 27, 22, 23, 24] };
const ROVER_PINS = { arduino: [5, 6, 7, 8, 9, 10], esp32: [25, 26, 27, 14, 32, 33], pico: [10, 11, 12, 13, 14, 15], rpi: [5, 6, 13, 19, 12, 18] };

function defaultRobot(kind = 'arm', brain = 'esp32') {
  if (kind === 'rover') { const p = ROVER_PINS[brain] || ROVER_PINS.esp32; return { kind: 'rover', name: 'Rover', brain, pins: { leftFwd: p[0], leftBack: p[1], rightFwd: p[2], rightBack: p[3], leftPwm: p[4], rightPwm: p[5] }, cmPerSec: 20, degPerSec: 90, stopPin: null }; }
  const p = PINS[brain] || PINS.esp32; const names = ['base', 'shoulder', 'elbow', 'wrist'];
  return { kind: 'arm', name: 'Robot arm', brain, joints: names.map((name, i) => ({ name, pin: p[i], min: name === 'shoulder' ? 15 : 0, max: name === 'shoulder' ? 165 : 180, home: 90 })), gripper: { pin: p[4], open: 60, close: 120 }, links: { base: 60, upper: 100, fore: 100, tool: 50 }, maxSpeed: 60, stopPin: null };
}
const DEFAULT_PROGRAM = (kind) => (kind === 'rover'
  ? [{ op: 'repeat', times: 4, steps: [{ op: 'forward', cm: 30 }, { op: 'wait', ms: 300 }, { op: 'turn', deg: 90 }] }, { op: 'stop' }]
  : [{ op: 'home' }, { op: 'grip', state: 'open' }, { op: 'reach', x: 140, y: 60, z: 15 }, { op: 'grip', state: 'close' }, { op: 'wait', ms: 400 }, { op: 'move', angles: [90, 90, 90, 90] }, { op: 'reach', x: 140, y: -60, z: 15 }, { op: 'grip', state: 'open' }, { op: 'home' }]);

const intIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw err(422, `${what} must be a whole number from ${lo} to ${hi}.`); return n; };
const numIn = (v, lo, hi, what) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw err(422, `${what} must be a number from ${lo} to ${hi}.`); return n; };
function cleanRobot(raw = {}) {
  const kind = raw.kind === 'rover' ? 'rover' : 'arm'; const brain = BRAINS[raw.brain] ? raw.brain : 'esp32'; const d = defaultRobot(kind, brain); const name = String(raw.name || d.name).slice(0, 40);
  if (kind === 'rover') {
    const pins = {}; const seen = new Set(); for (const k of Object.keys(d.pins)) { pins[k] = intIn(raw.pins && raw.pins[k] !== undefined ? raw.pins[k] : d.pins[k], 0, 60, `Pin ${k}`); if (seen.has(pins[k])) throw err(422, 'Each motor pin must be different.'); seen.add(pins[k]); }
    return { kind, name, brain, pins, cmPerSec: numIn(raw.cmPerSec ?? d.cmPerSec, 1, 200, 'Speed in cm per second'), degPerSec: numIn(raw.degPerSec ?? d.degPerSec, 5, 720, 'Turn rate in degrees per second'), stopPin: raw.stopPin === null || raw.stopPin === undefined || raw.stopPin === '' ? null : intIn(raw.stopPin, 0, 60, 'Stop button pin') };
  }
  const src = Array.isArray(raw.joints) && raw.joints.length === 4 ? raw.joints : d.joints; const seen = new Set();
  const joints = src.map((j, i) => { const o = { name: d.joints[i].name, pin: intIn(j.pin ?? d.joints[i].pin, 0, 60, `${d.joints[i].name} pin`), min: numIn(j.min ?? d.joints[i].min, 0, 180, `${d.joints[i].name} minimum`), max: numIn(j.max ?? d.joints[i].max, 0, 180, `${d.joints[i].name} maximum`), home: numIn(j.home ?? d.joints[i].home, 0, 180, `${d.joints[i].name} home`) }; if (o.min >= o.max) throw err(422, `${o.name}: the minimum angle must be below the maximum.`); if (o.home < o.min || o.home > o.max) throw err(422, `${o.name}: home must sit between its minimum and maximum.`); if (seen.has(o.pin)) throw err(422, 'Each servo needs its own pin.'); seen.add(o.pin); return o; });
  const g = raw.gripper || d.gripper; const gr = { pin: intIn(g.pin ?? d.gripper.pin, 0, 60, 'Gripper pin'), open: numIn(g.open ?? d.gripper.open, 0, 180, 'Gripper open angle'), close: numIn(g.close ?? d.gripper.close, 0, 180, 'Gripper closed angle') }; if (seen.has(gr.pin)) throw err(422, 'Each servo needs its own pin.');
  const l = raw.links || d.links; const links = { base: numIn(l.base ?? d.links.base, 0, 500, 'Base height'), upper: numIn(l.upper ?? d.links.upper, 20, 500, 'Upper arm length'), fore: numIn(l.fore ?? d.links.fore, 20, 500, 'Forearm length'), tool: numIn(l.tool ?? d.links.tool, 0, 300, 'Gripper length') };
  return { kind, name, brain, joints, gripper: gr, links, maxSpeed: numIn(raw.maxSpeed ?? d.maxSpeed, 5, 180, 'Top speed in degrees per second'), stopPin: raw.stopPin === null || raw.stopPin === undefined || raw.stopPin === '' ? null : intIn(raw.stopPin, 0, 60, 'Stop button pin') };
}

// ---- arm geometry ---------------------------------------------------------------------------------------------------------------
/** Angles are servo degrees. 90 on the base faces forward (+X). 90 on the shoulder is straight up. 90 on elbow and wrist means in line with the part before it. */
function forward(cfg, a) {
  const L = cfg.links, p1 = a[1] * DEG, pf = p1 + (a[2] - 90) * DEG, pw = pf + (a[3] - 90) * DEG, yaw = (a[0] - 90) * DEG;
  const rad = L.upper * Math.cos(p1) + L.fore * Math.cos(pf) + L.tool * Math.cos(pw); const z = L.base + L.upper * Math.sin(p1) + L.fore * Math.sin(pf) + L.tool * Math.sin(pw);
  return [r1(rad * Math.cos(yaw)), r1(rad * Math.sin(yaw)), r1(z)];
}
function joints3d(cfg, a) {
  const L = cfg.links, p1 = a[1] * DEG, pf = p1 + (a[2] - 90) * DEG, pw = pf + (a[3] - 90) * DEG, yaw = (a[0] - 90) * DEG; const pts = [[0, 0, 0], [0, 0, L.base]]; let r = 0, z = L.base;
  for (const [len, ang] of [[L.upper, p1], [L.fore, pf], [L.tool, pw]]) { r += len * Math.cos(ang); z += len * Math.sin(ang); pts.push([r * Math.cos(yaw), r * Math.sin(yaw), z]); }
  return pts.map((p) => p.map(r1));
}
/** Where the arm must bend to put the gripper tip on (x, y, z) with the gripper pointing straight down. */
function reach(cfg, x, y, z) {
  const L = cfg.links; const yaw = Math.atan2(y, x), rt = Math.hypot(x, y), zt = z + L.tool - L.base; const d = Math.hypot(rt, zt);
  if (d > L.upper + L.fore - 0.5 || d < Math.abs(L.upper - L.fore) + 0.5) throw err(422, `The point (${x}, ${y}, ${z}) mm is out of reach. The arm reaches about ${r1(L.upper + L.fore)} mm out from its shoulder.`);
  const cosG = (L.upper ** 2 + L.fore ** 2 - d * d) / (2 * L.upper * L.fore), gamma = Math.acos(Math.max(-1, Math.min(1, cosG))); const beta = Math.PI - gamma;
  const cosA = (L.upper ** 2 + d * d - L.fore ** 2) / (2 * L.upper * d), p1 = Math.atan2(zt, rt) + Math.acos(Math.max(-1, Math.min(1, cosA))); const pf = p1 - beta;
  const a = [90 + yaw / DEG, p1 / DEG, 90 - beta / DEG, 90 + (-Math.PI / 2 - pf) / DEG].map(r2);
  cfg.joints.forEach((j, i) => { if (a[i] < j.min - 0.01 || a[i] > j.max + 0.01) throw err(422, `The point (${x}, ${y}, ${z}) mm needs the ${j.name} at ${a[i]} degrees, outside its limit of ${j.min} to ${j.max}.`); });
  return a;
}

// ---- program checking -----------------------------------------------------------------------------------------------------------
const MAX_STEPS = 300, MAX_EXPANDED = 3000;
/** Validates the steps and turns "reach" steps into plain moves. Returns a clean copy. */
function compile(cfgRaw, steps) {
  const cfg = cleanRobot(cfgRaw); if (!Array.isArray(steps) || !steps.length) throw err(422, 'Add at least one step.'); let count = 0, expanded = 1;
  const walk = (list, depth, mult) => list.map((s, i) => {
    if (++count > MAX_STEPS) throw err(422, `A program can have up to ${MAX_STEPS} steps.`); const at = `Step ${count}`; if (!s || typeof s !== 'object') throw err(422, `${at} is not a step.`); void i;
    const arm = cfg.kind === 'arm';
    switch (s.op) {
      case 'wait': return { op: 'wait', ms: intIn(s.ms, 0, 60000, `${at}: the wait`) };
      case 'repeat': { if (depth >= 2) throw err(422, `${at}: repeats can be nested two levels deep.`); const t = intIn(s.times, 1, 1000, `${at}: repeat count`); const m = mult * t; if (m > MAX_EXPANDED) throw err(422, 'This program would run too many steps in total. Reduce the repeat counts.'); expanded = Math.max(expanded, m); if (!Array.isArray(s.steps) || !s.steps.length) throw err(422, `${at}: a repeat needs steps inside it.`); return { op: 'repeat', times: t, steps: walk(s.steps, depth + 1, m) }; }
      case 'home': if (!arm) break; return { op: 'home' };
      case 'grip': if (!arm) break; if (s.state !== 'open' && s.state !== 'close') throw err(422, `${at}: the gripper is open or close.`); return { op: 'grip', state: s.state };
      case 'move': { if (!arm) break; if (!Array.isArray(s.angles) || s.angles.length !== 4) throw err(422, `${at}: give four angles (base, shoulder, elbow, wrist).`); const a = s.angles.map((v, k) => numIn(v, 0, 180, `${at}: ${cfg.joints[k].name} angle`)); a.forEach((v, k) => { const j = cfg.joints[k]; if (v < j.min || v > j.max) throw err(422, `${at}: the ${j.name} is set to ${v} degrees, outside its limit of ${j.min} to ${j.max}.`); }); const o = { op: 'move', angles: a }; if (s.speed !== undefined && s.speed !== '') o.speed = numIn(s.speed, 5, cfg.maxSpeed, `${at}: speed (top is ${cfg.maxSpeed})`); return o; }
      case 'reach': { if (!arm) break; const x = numIn(s.x, -1000, 1000, `${at}: x`), y = numIn(s.y, -1000, 1000, `${at}: y`), z = numIn(s.z, -200, 1000, `${at}: z`); if (z < 0) throw err(422, `${at}: z is below the table. Use 0 or more.`); const o = { op: 'move', angles: reach(cfg, x, y, z), from: { x, y, z } }; if (s.speed !== undefined && s.speed !== '') o.speed = numIn(s.speed, 5, cfg.maxSpeed, `${at}: speed`); return o; }
      case 'forward': case 'back': if (arm) break; return { op: s.op, cm: numIn(s.cm, 1, 500, `${at}: distance in cm`) };
      case 'turn': if (arm) break; return { op: 'turn', deg: numIn(s.deg, -720, 720, `${at}: turn in degrees`) };
      case 'stop': if (arm) break; return { op: 'stop' };
      default: break;
    }
    throw err(422, `${at}: "${s.op}" is not a step this ${cfg.kind === 'arm' ? 'arm' : 'rover'} can do.`);
  });
  return { cfg, steps: walk(steps, 0, 1), expanded };
}

// ---- simulation -----------------------------------------------------------------------------------------------------------------
function simulate(cfgRaw, stepsRaw) {
  const { cfg, steps } = compile(cfgRaw, stepsRaw); const frames = []; const warnings = []; let t = 0;
  const push = (f) => { if (frames.length > 6000) throw err(422, 'This program is too long to play. Shorten it.'); frames.push({ t: r2(t), ...f }); };
  if (cfg.kind === 'arm') {
    let a = cfg.joints.map((j) => j.home), g = cfg.gripper.open; const tipLow = new Set(); push({ a: a.slice(), g: 1, tip: forward(cfg, a), note: 'start' });
    const toGrip = (st) => (st === 'open' ? 1 : 0);
    const go = (na, speed, note) => { const sp = Math.min(speed || cfg.maxSpeed, cfg.maxSpeed); const dur = Math.max(...na.map((v, i) => Math.abs(v - a[i]))) / sp; const n = Math.max(1, Math.ceil(dur / 0.1)); const from = a.slice(); for (let k = 1; k <= n; k++) { const e = k / n, s = e * e * (3 - 2 * e); const cur = from.map((v, i) => v + (na[i] - v) * s); const tip = forward(cfg, cur); if (tip[2] < 0 && !tipLow.has(note)) { tipLow.add(note); warnings.push(`${note}: the gripper tip goes below the table (z ${tip[2]} mm) on the way.`); } t += dur / n; push({ a: cur.map(r2), g: frames[frames.length - 1].g, tip, note }); } a = na.slice(); };
    const run = (list) => { for (const s of list) { if (s.op === 'repeat') { for (let k = 0; k < s.times; k++) run(s.steps); } else if (s.op === 'home') go(cfg.joints.map((j) => j.home), cfg.maxSpeed, 'home'); else if (s.op === 'move') go(s.angles, s.speed, s.from ? `reach (${s.from.x}, ${s.from.y}, ${s.from.z})` : `move ${s.angles.join(', ')}`); else if (s.op === 'grip') { t += 0.5; g = s.state === 'open' ? cfg.gripper.open : cfg.gripper.close; push({ a: a.slice(), g: toGrip(s.state), tip: forward(cfg, a), note: 'gripper ' + s.state }); } else if (s.op === 'wait') { t += s.ms / 1000; push({ a: a.slice(), g: frames[frames.length - 1].g, tip: forward(cfg, a), note: 'wait' }); } } };
    run(steps); void g;
    const tips = frames.map((f) => f.tip); const reachMax = Math.max(...tips.map((p) => Math.hypot(p[0], p[1]))); return { kind: 'arm', duration: r1(t), frames, warnings, summary: { steps: frames.length, maxReachMm: r1(reachMax), links: cfg.links } };
  }
  let x = 0, y = 0, h = 0; push({ x, y, h, note: 'start' });
  const drive = (cm, note) => { const dur = Math.abs(cm) / cfg.cmPerSec; const n = Math.max(1, Math.ceil(dur / 0.1)); for (let k = 1; k <= n; k++) { x += (cm / n) * Math.cos(h * DEG); y += (cm / n) * Math.sin(h * DEG); t += dur / n; push({ x: r1(x), y: r1(y), h: r1(h), note }); } };
  const turn = (deg) => { const dur = Math.abs(deg) / cfg.degPerSec; const n = Math.max(1, Math.ceil(dur / 0.1)); for (let k = 1; k <= n; k++) { h += deg / n; t += dur / n; push({ x: r1(x), y: r1(y), h: r1(h), note: 'turn' }); } };
  const run = (list) => { for (const s of list) { if (s.op === 'repeat') { for (let k = 0; k < s.times; k++) run(s.steps); } else if (s.op === 'forward') drive(s.cm, 'forward'); else if (s.op === 'back') drive(-s.cm, 'back'); else if (s.op === 'turn') turn(s.deg); else { t += s.op === 'wait' ? s.ms / 1000 : 0; push({ x: r1(x), y: r1(y), h: r1(h), note: s.op }); } } };
  run(steps); warnings.push('Wheels slip, so a real rover drifts. Distances and turns are open loop: they use the speeds you entered, with no sensors.');
  return { kind: 'rover', duration: r1(t), frames, warnings, summary: { steps: frames.length, endX: r1(x), endY: r1(y), endHeading: r1(h) } };
}

// ---- code export ----------------------------------------------------------------------------------------------------------------
const pyName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'robot';
function body(steps, cfg, lang, ind, depth = 0) {
  const pad = '    '.repeat(ind); const out = []; const cpp = lang === 'cpp';
  for (const s of steps) {
    if (s.op === 'repeat') { const v = 'i' + (depth + 1); out.push(cpp ? `${pad}for (int ${v} = 0; ${v} < ${s.times}; ${v}++) {` : `${pad}for ${v} in range(${s.times}):`); out.push(...body(s.steps, cfg, lang, ind + 1, depth + 1)); if (cpp) out.push(`${pad}}`); }
    else if (s.op === 'move') out.push(`${pad}${cpp ? 'moveTo' : 'move_to'}(${s.angles.join(', ')}, ${s.speed || cfg.maxSpeed})${cpp ? ';' : ''}${s.from ? `  ${cpp ? '//' : '#'} reach ${s.from.x}, ${s.from.y}, ${s.from.z} mm` : ''}`);
    else if (s.op === 'home') out.push(`${pad}${cpp ? 'goHome();' : 'go_home()'}`);
    else if (s.op === 'grip') out.push(`${pad}grip(${cpp ? (s.state === 'open' ? 'true' : 'false') : (s.state === 'open' ? 'True' : 'False')})${cpp ? ';' : ''}`);
    else if (s.op === 'wait') out.push(`${pad}pause(${s.ms})${cpp ? ';' : ''}`);
    else if (s.op === 'forward') out.push(`${pad}drive(${s.cm})${cpp ? ';' : ''}`);
    else if (s.op === 'back') out.push(`${pad}drive(${-s.cm})${cpp ? ';' : ''}`);
    else if (s.op === 'turn') out.push(`${pad}turn(${s.deg})${cpp ? ';' : ''}`);
    else if (s.op === 'stop') out.push(`${pad}${cpp ? 'stopMotors();' : 'stop_motors()'}`);
  }
  return out;
}
const HEAD = (cfg, how) => `Made by Dry Run for "${cfg.name}" (${BRAINS[cfg.brain].label}). ${how}`;
const SAFETY = 'Safety: keep hands clear of the arm while it moves. Power the servos from their own supply, not from the board pin. Test with the gripper empty first. Every angle is held inside the limits you set in Dry Run.';

function cppArm(cfg, steps) {
  const esp = cfg.brain === 'esp32'; const J = cfg.joints; const pins = [...J.map((j) => j.pin), cfg.gripper.pin]; const mins = [...J.map((j) => j.min), Math.min(cfg.gripper.open, cfg.gripper.close)]; const maxs = [...J.map((j) => j.max), Math.max(cfg.gripper.open, cfg.gripper.close)]; const home = [...J.map((j) => j.home), cfg.gripper.open];
  return `// ${HEAD(cfg, 'Open this in the Arduino IDE' + (esp ? ' with the ESP32 board package and the ESP32Servo library.' : '.'))}
// ${SAFETY}
#include <${esp ? 'ESP32Servo.h' : 'Servo.h'}>

const int PIN[5]  = {${pins.join(', ')}};            // base, shoulder, elbow, wrist, gripper
const float MIN_A[5] = {${mins.join(', ')}};
const float MAX_A[5] = {${maxs.join(', ')}};
const float HOME_A[5] = {${home.join(', ')}};
const float GRIP_OPEN = ${cfg.gripper.open}, GRIP_CLOSE = ${cfg.gripper.close};
const float MAX_SPEED = ${cfg.maxSpeed};             // degrees per second
${cfg.stopPin !== null ? `const int STOP_PIN = ${cfg.stopPin};                   // wire a button from this pin to GND\n` : ''}const bool RUN_FOREVER = false;               // true repeats the program until power is removed

Servo servo[5];
float cur[5];

void haltForever() { for (int i = 0; i < 5; i++) servo[i].detach(); while (true) { delay(1000); } }
void checkStop() { ${cfg.stopPin !== null ? 'if (digitalRead(STOP_PIN) == LOW) haltForever();' : ''} }   // stop button: ${cfg.stopPin !== null ? 'on' : 'not configured'}
void pause(unsigned long ms) { unsigned long t0 = millis(); while (millis() - t0 < ms) { checkStop(); delay(5); } }
float limit(int i, float a) { return a < MIN_A[i] ? MIN_A[i] : (a > MAX_A[i] ? MAX_A[i] : a); }
void writeAll() { for (int i = 0; i < 5; i++) servo[i].write((int)(limit(i, cur[i]) + 0.5)); }

// Moves all four arm joints together, in a straight blend, no faster than "speed" degrees per second.
void moveTo(float a0, float a1, float a2, float a3, float speed) {
  float to[4] = {a0, a1, a2, a3}, from[4]; float big = 0;
  for (int i = 0; i < 4; i++) { to[i] = limit(i, to[i]); from[i] = cur[i]; if (fabs(to[i] - from[i]) > big) big = fabs(to[i] - from[i]); }
  if (speed > MAX_SPEED) speed = MAX_SPEED;
  int n = (int)(big / speed * 50) + 1;                                   // 20 ms per step
  for (int k = 1; k <= n; k++) { float e = (float)k / n; float s = e * e * (3 - 2 * e); for (int i = 0; i < 4; i++) cur[i] = from[i] + (to[i] - from[i]) * s; writeAll(); checkStop(); delay(20); }
}
void grip(bool open) { cur[4] = open ? GRIP_OPEN : GRIP_CLOSE; writeAll(); pause(500); }
void goHome() { moveTo(HOME_A[0], HOME_A[1], HOME_A[2], HOME_A[3], MAX_SPEED); }

void runProgram() {
${body(steps, cfg, 'cpp', 1).join('\n')}
}

void setup() {
${cfg.stopPin !== null ? '  pinMode(STOP_PIN, INPUT_PULLUP);\n' : ''}  for (int i = 0; i < 5; i++) { cur[i] = HOME_A[i]; servo[i].attach(PIN[i]); servo[i].write((int)HOME_A[i]); delay(300); }
  delay(1000);
  do { runProgram(); } while (RUN_FOREVER);
}
void loop() {}
`;
}
function cppRover(cfg, steps) {
  const p = cfg.pins; const esp = cfg.brain === 'esp32';
  return `// ${HEAD(cfg, 'Open this in the Arduino IDE.')}
// Safety: lift the wheels off the table for the first test. Distances are timed, not measured, so tune CM_PER_SEC and DEG_PER_SEC on your own floor.
// Wiring: a dual H-bridge motor driver (for example an L298N). Left motor on ${p.leftFwd}/${p.leftBack}, right motor on ${p.rightFwd}/${p.rightBack}, speed pins ${p.leftPwm} and ${p.rightPwm}.
const int L_FWD = ${p.leftFwd}, L_BACK = ${p.leftBack}, R_FWD = ${p.rightFwd}, R_BACK = ${p.rightBack}, L_PWM = ${p.leftPwm}, R_PWM = ${p.rightPwm};
const float CM_PER_SEC = ${cfg.cmPerSec}, DEG_PER_SEC = ${cfg.degPerSec};
const int SPEED = 180;                         // 0 to 255
${cfg.stopPin !== null ? `const int STOP_PIN = ${cfg.stopPin};                 // wire a button from this pin to GND\n` : ''}
void motors(int l, int r) { digitalWrite(L_FWD, l > 0); digitalWrite(L_BACK, l < 0); digitalWrite(R_FWD, r > 0); digitalWrite(R_BACK, r < 0); ${esp ? 'analogWrite(L_PWM, l ? SPEED : 0); analogWrite(R_PWM, r ? SPEED : 0);' : 'analogWrite(L_PWM, l ? SPEED : 0); analogWrite(R_PWM, r ? SPEED : 0);'} }
void stopMotors() { motors(0, 0); }
void haltForever() { stopMotors(); while (true) { delay(1000); } }
void pause(unsigned long ms) { unsigned long t0 = millis(); while (millis() - t0 < ms) { ${cfg.stopPin !== null ? 'if (digitalRead(STOP_PIN) == LOW) haltForever();' : ''} delay(5); } }
void drive(float cm) { motors(cm > 0 ? 1 : -1, cm > 0 ? 1 : -1); pause((unsigned long)(fabs(cm) / CM_PER_SEC * 1000)); stopMotors(); }
void turn(float deg) { motors(deg > 0 ? 1 : -1, deg > 0 ? -1 : 1); pause((unsigned long)(fabs(deg) / DEG_PER_SEC * 1000)); stopMotors(); }

void runProgram() {
${body(steps, cfg, 'cpp', 1).join('\n')}
}
void setup() {
  int pins[6] = {L_FWD, L_BACK, R_FWD, R_BACK, L_PWM, R_PWM}; for (int i = 0; i < 6; i++) pinMode(pins[i], OUTPUT);
${cfg.stopPin !== null ? '  pinMode(STOP_PIN, INPUT_PULLUP);\n' : ''}  stopMotors(); delay(2000);
  runProgram(); stopMotors();
}
void loop() {}
`;
}
function pyArm(cfg, steps) {
  const pico = cfg.brain === 'pico'; const J = cfg.joints; const pins = [...J.map((j) => j.pin), cfg.gripper.pin];
  const head = pico ? 'from machine import Pin, PWM\nfrom time import sleep_ms, ticks_ms, ticks_diff' : 'from gpiozero import AngularServo, Button\nfrom gpiozero.pins.pigpio import PiGPIOFactory\nfrom time import sleep, monotonic';
  return `# ${HEAD(cfg, pico ? 'Save as main.py on the Pico (Thonny works well).' : 'Run it with: python3 program.py   (start the pigpio daemon first: sudo pigpiod).')}
# ${SAFETY}
${head}

PIN = [${pins.join(', ')}]               # base, shoulder, elbow, wrist, gripper
MIN_A = [${[...J.map((j) => j.min), Math.min(cfg.gripper.open, cfg.gripper.close)].join(', ')}]
MAX_A = [${[...J.map((j) => j.max), Math.max(cfg.gripper.open, cfg.gripper.close)].join(', ')}]
HOME_A = [${[...J.map((j) => j.home), cfg.gripper.open].join(', ')}]
GRIP_OPEN, GRIP_CLOSE = ${cfg.gripper.open}, ${cfg.gripper.close}
MAX_SPEED = ${cfg.maxSpeed}                # degrees per second
RUN_FOREVER = False
${pico ? `servo = [PWM(Pin(p), freq=50) for p in PIN]\n${cfg.stopPin !== null ? `stop_button = Pin(${cfg.stopPin}, Pin.IN, Pin.PULL_UP)   # button from this pin to GND\n` : ''}` : `factory = PiGPIOFactory()\nservo = [AngularServo(p, min_angle=0, max_angle=180, min_pulse_width=0.0005, max_pulse_width=0.0025, pin_factory=factory) for p in PIN]\n${cfg.stopPin !== null ? `stop_button = Button(${cfg.stopPin}, pull_up=True)   # button from this pin to GND\n` : ''}`}cur = list(HOME_A)

def limit(i, a):
    return max(MIN_A[i], min(MAX_A[i], a))

def write_all():
    for i in range(5):
        a = limit(i, cur[i])
${pico ? '        servo[i].duty_u16(int((500 + a / 180 * 2000) / 20000 * 65535))' : '        servo[i].angle = a'}

def halt_forever():
${pico ? '    for s in servo:\n        s.deinit()\n    while True:\n        sleep_ms(1000)' : '    for s in servo:\n        s.detach()\n    raise SystemExit("Stopped by the stop button")'}

def check_stop():
${cfg.stopPin !== null ? `    if ${pico ? 'stop_button.value() == 0' : 'stop_button.is_pressed'}:\n        halt_forever()` : '    pass   # no stop button configured'}

def pause(ms):
    ${pico ? 't0 = ticks_ms()\n    while ticks_diff(ticks_ms(), t0) < ms:\n        check_stop()\n        sleep_ms(5)' : 't0 = monotonic()\n    while (monotonic() - t0) * 1000 < ms:\n        check_stop()\n        sleep(0.005)'}

def move_to(a0, a1, a2, a3, speed):
    """Moves the four arm joints together, no faster than speed degrees per second."""
    speed = min(speed, MAX_SPEED)
    to = [limit(i, v) for i, v in enumerate((a0, a1, a2, a3))]
    frm = cur[:4]
    big = max(abs(t - f) for t, f in zip(to, frm))
    n = int(big / speed * 50) + 1          # 20 ms per step
    for k in range(1, n + 1):
        e = k / n
        s = e * e * (3 - 2 * e)
        for i in range(4):
            cur[i] = frm[i] + (to[i] - frm[i]) * s
        write_all()
        check_stop()
        pause(20)

def grip(open_):
    cur[4] = GRIP_OPEN if open_ else GRIP_CLOSE
    write_all()
    pause(500)

def go_home():
    move_to(HOME_A[0], HOME_A[1], HOME_A[2], HOME_A[3], MAX_SPEED)

def run_program():
${body(steps, cfg, 'py', 1).join('\n')}

write_all()
pause(1000)
try:
    while True:
        run_program()
        if not RUN_FOREVER:
            break
finally:
${pico ? '    pass' : '    pass'}
`;
}
function pyRover(cfg, steps) {
  const pico = cfg.brain === 'pico'; const p = cfg.pins;
  return `# ${HEAD(cfg, pico ? 'Save as main.py on the Pico.' : 'Run it with: python3 program.py')}
# Safety: lift the wheels off the table for the first test. Distances are timed, not measured, so tune CM_PER_SEC and DEG_PER_SEC on your own floor.
# Wiring: a dual H-bridge motor driver (for example an L298N). Left motor on ${p.leftFwd}/${p.leftBack}, right motor on ${p.rightFwd}/${p.rightBack}, speed pins ${p.leftPwm} and ${p.rightPwm}.
${pico ? 'from machine import Pin, PWM\nfrom time import sleep_ms, ticks_ms, ticks_diff' : 'from gpiozero import Motor, Button\nfrom time import sleep, monotonic'}
CM_PER_SEC, DEG_PER_SEC, SPEED = ${cfg.cmPerSec}, ${cfg.degPerSec}, 0.7
${pico ? `lf, lb, rf, rb = [Pin(n, Pin.OUT) for n in (${p.leftFwd}, ${p.leftBack}, ${p.rightFwd}, ${p.rightBack})]\nlpwm, rpwm = PWM(Pin(${p.leftPwm}), freq=1000), PWM(Pin(${p.rightPwm}), freq=1000)\n${cfg.stopPin !== null ? `stop_button = Pin(${cfg.stopPin}, Pin.IN, Pin.PULL_UP)\n` : ''}` : `left = Motor(forward=${p.leftFwd}, backward=${p.leftBack}, enable=${p.leftPwm})\nright = Motor(forward=${p.rightFwd}, backward=${p.rightBack}, enable=${p.rightPwm})\n${cfg.stopPin !== null ? `stop_button = Button(${cfg.stopPin}, pull_up=True)\n` : ''}`}
def motors(l, r):
${pico ? '    lf.value(l > 0); lb.value(l < 0); rf.value(r > 0); rb.value(r < 0)\n    lpwm.duty_u16(int(65535 * SPEED) if l else 0); rpwm.duty_u16(int(65535 * SPEED) if r else 0)' : '    (left.forward(SPEED) if l > 0 else left.backward(SPEED) if l < 0 else left.stop())\n    (right.forward(SPEED) if r > 0 else right.backward(SPEED) if r < 0 else right.stop())'}

def stop_motors():
    motors(0, 0)

def pause(ms):
    ${pico ? 't0 = ticks_ms()\n    while ticks_diff(ticks_ms(), t0) < ms:\n        ' : 't0 = monotonic()\n    while (monotonic() - t0) * 1000 < ms:\n        '}${cfg.stopPin !== null ? `if ${pico ? 'stop_button.value() == 0' : 'stop_button.is_pressed'}:\n            stop_motors()\n            raise SystemExit("Stopped by the stop button")\n        ` : ''}${pico ? 'sleep_ms(5)' : 'sleep(0.005)'}

def drive(cm):
    motors(1 if cm > 0 else -1, 1 if cm > 0 else -1)
    pause(int(abs(cm) / CM_PER_SEC * 1000))
    stop_motors()

def turn(deg):
    motors(1 if deg > 0 else -1, -1 if deg > 0 else 1)
    pause(int(abs(deg) / DEG_PER_SEC * 1000))
    stop_motors()

def run_program():
${body(steps, cfg, 'py', 1).join('\n')}

stop_motors()
pause(2000)
try:
    run_program()
finally:
    stop_motors()
`;
}
function ros2Files(cfg, steps) {
  const pkg = 'dryrun_' + pyName(cfg.name); const frames = simulate(cfg, steps);
  let program;
  if (cfg.kind === 'arm') {
    // Waypoints at every plain move, in radians from the home pose, with the time each should be reached.
    const pts = []; let prev = frames.frames[0]; const rad = (a, i) => r2((a - cfg.joints[i].home) * DEG);
    for (const f of frames.frames) { if (f.note === 'start' || /^(move|reach|home)/.test(f.note) || /^gripper/.test(f.note)) { const last = pts[pts.length - 1]; const row = [...f.a.map(rad), f.g ? 0 : r2((cfg.gripper.close - cfg.gripper.open) * DEG)]; if (!last || f.t - last.t >= 0.2 || /^gripper/.test(f.note)) pts.push({ t: Math.max(f.t, last ? last.t + 0.05 : 0.05), p: row }); } prev = f; } void prev;
    program = `JOINTS = ${JSON.stringify([...cfg.joints.map((j) => j.name + '_joint'), 'gripper_joint'])}\nTOPIC = '/joint_trajectory_controller/joint_trajectory'   # change to match your controller\nPOINTS = ${JSON.stringify(pts.map((x) => [r2(x.t), x.p]))}   # (seconds from start, joint positions in radians from the home pose)\n\n\ndef make_message():\n    msg = JointTrajectory()\n    msg.joint_names = JOINTS\n    for t, pos in POINTS:\n        pt = JointTrajectoryPoint()\n        pt.positions = list(pos)\n        pt.time_from_start = Duration(seconds=t).to_msg()\n        msg.points.append(pt)\n    return msg\n`;
  } else {
    const pts = []; let last = null; for (const f of frames.frames) { if (!last || f.t - last.t >= 0.1) { if (last) pts.push({ t: r2(f.t - last.t), v: r2(Math.hypot(f.x - last.x, f.y - last.y) / 100 / Math.max(0.05, f.t - last.t)), w: r2(((f.h - last.h) * DEG) / Math.max(0.05, f.t - last.t)) }); last = f; } }
    program = `TOPIC = '/cmd_vel'\nSEGMENTS = ${JSON.stringify(pts.map((s) => [s.t, s.v, s.w]))}   # (seconds, metres per second, radians per second)\n`;
  }
  const arm = cfg.kind === 'arm';
  const node = `"""${HEAD(cfg, 'ROS 2 node that plays the program.')}\n${SAFETY}\nRun: ros2 run ${pkg} play\n"""\nimport rclpy\nfrom rclpy.node import Node\n${arm ? 'from rclpy.duration import Duration\nfrom trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint' : 'from geometry_msgs.msg import Twist'}\n\n${program}\n\nclass Play(Node):\n    def __init__(self):\n        super().__init__('dryrun_play')\n        self.pub = self.create_publisher(${arm ? 'JointTrajectory' : 'Twist'}, TOPIC, 10)\n${arm ? '        self.timer = self.create_timer(1.0, self.once)\n        self.sent = False\n\n    def once(self):\n        if self.sent:\n            return\n        self.sent = True\n        self.pub.publish(make_message())\n        self.get_logger().info(f"Sent {len(POINTS)} waypoints")\n' : '        self.i, self.t0 = 0, self.get_clock().now()\n        self.timer = self.create_timer(0.05, self.tick)\n\n    def tick(self):\n        now = (self.get_clock().now() - self.t0).nanoseconds / 1e9\n        total = 0.0\n        for secs, v, w in SEGMENTS:\n            total += secs\n            if now < total:\n                m = Twist(); m.linear.x = float(v); m.angular.z = float(w); self.pub.publish(m); return\n        self.pub.publish(Twist())   # stop\n        self.get_logger().info("Done")\n        self.timer.cancel()\n'}\n\ndef main():\n    rclpy.init()\n    node = Play()\n    try:\n        rclpy.spin(node)\n    except KeyboardInterrupt:\n        pass\n${arm ? '' : '    finally:\n        node.pub.publish(Twist())\n'}    node.destroy_node()\n    rclpy.try_shutdown()\n`;
  return [
    { path: `${pkg}/package.xml`, content: `<?xml version="1.0"?>\n<package format="3">\n  <name>${pkg}</name>\n  <version>0.1.0</version>\n  <description>Program for ${cfg.name}, made by Dry Run</description>\n  <maintainer email="you@example.com">you</maintainer>\n  <license>Apache-2.0</license>\n  <depend>rclpy</depend>\n  <depend>${arm ? 'trajectory_msgs' : 'geometry_msgs'}</depend>\n  <export><build_type>ament_python</build_type></export>\n</package>\n` },
    { path: `${pkg}/setup.py`, content: `from setuptools import setup\n\npackage_name = '${pkg}'\nsetup(\n    name=package_name, version='0.1.0', packages=[package_name],\n    data_files=[('share/ament_index/resource_index/packages', ['resource/' + package_name]), ('share/' + package_name, ['package.xml'])],\n    install_requires=['setuptools'], zip_safe=True, maintainer='you', maintainer_email='you@example.com',\n    description='Program for ${cfg.name}', license='Apache-2.0',\n    entry_points={'console_scripts': ['play = ${pkg}.play:main']},\n)\n` },
    { path: `${pkg}/setup.cfg`, content: `[develop]\nscript_dir=$base/lib/${pkg}\n[install]\ninstall_scripts=$base/lib/${pkg}\n` },
    { path: `${pkg}/resource/${pkg}`, content: '' },
    { path: `${pkg}/${pkg}/__init__.py`, content: '' },
    { path: `${pkg}/${pkg}/play.py`, content: node },
    { path: `${pkg}/README.md`, content: `# ${cfg.name} (ROS 2)\n\nMade by Dry Run. Build and run:\n\n    cd ~/ros2_ws/src && unzip ${pkg}.zip\n    cd ~/ros2_ws && colcon build --packages-select ${pkg}\n    source install/setup.bash\n    ros2 run ${pkg} play\n\n${arm ? `The node publishes one JointTrajectory to the topic set at the top of play.py. Your controller must accept joints named ${[...cfg.joints.map((j) => j.name + '_joint'), 'gripper_joint'].join(', ')}. Positions are radians from the home pose. The controller, not this node, enforces your robot's real limits.\n` : 'The node publishes velocity commands on /cmd_vel. Your base controller must accept geometry_msgs/Twist.\n'}\n${SAFETY}\n` },
  ];
}
/** Returns { files: [{ path, content }], language, notes } */
function exportCode(cfgRaw, stepsRaw) {
  const { cfg, steps } = compile(cfgRaw, stepsRaw); const lang = BRAINS[cfg.brain].lang; const arm = cfg.kind === 'arm'; const base = pyName(cfg.name);
  if (cfg.brain === 'ros2') return { language: 'ROS 2 package (Python)', files: ros2Files(cfg, stepsRaw && steps), notes: ['Build it in a ROS 2 workspace. The controller on your robot enforces its real limits.'] };
  if (lang === 'cpp') return { language: cfg.brain === 'esp32' ? 'Arduino C++ for ESP32' : 'Arduino C++', files: [{ path: `${base}/${base}.ino`, content: (arm ? cppArm(cfg, steps) : cppRover(cfg, steps)).replace(/\bpause\(/g, 'waitMs(') }], notes: [cfg.brain === 'esp32' ? 'Install the ESP32 board package and the ESP32Servo library.' : 'Uses the built-in Servo library.', 'Power servos and motors from their own supply and join the grounds.'] };
  return { language: cfg.brain === 'pico' ? 'MicroPython for Raspberry Pi Pico' : 'Python for Raspberry Pi', files: [{ path: cfg.brain === 'pico' ? 'main.py' : `${base}.py`, content: arm ? pyArm(cfg, steps) : pyRover(cfg, steps) }], notes: [cfg.brain === 'pico' ? 'Copy main.py to the Pico with Thonny.' : 'Install pigpio and gpiozero, and start the daemon: sudo pigpiod.', 'Power servos and motors from their own supply and join the grounds.'] };
}

// ---- a tiny ZIP writer (stored, no compression) for the ROS 2 package ----------------------------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {
  const parts = [], central = []; let off = 0;
  for (const f of files) { const name = Buffer.from(f.path), data = Buffer.from(f.content), crc = crc32(data); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28); parts.push(h, name, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42); central.push(c, name); off += 30 + name.length + data.length; }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
void zlib;
module.exports = { BRAINS, defaultRobot, DEFAULT_PROGRAM, cleanRobot, compile, simulate, exportCode, forward, joints3d, reach, zip, crc32 };
