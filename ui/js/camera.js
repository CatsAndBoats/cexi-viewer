// Orbit + WASD fly camera. Entities use FFXI Y-down (up = −Y); zones match the
// level editor's Y-up display (−x, −y, z).

export function mat4Perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4LookAt(eye, target, up) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0]; out[4] = x[1]; out[8] = x[2];
  out[1] = y[0]; out[5] = y[1]; out[9] = y[2];
  out[2] = z[0]; out[6] = z[1]; out[10] = z[2];
  out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  out[15] = 1;
  return out;
}

export function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export const FLY_SPEED_MIN = 1;
export const FLY_SPEED_MAX = 300;
/** Zone fly default (half the old 50). Entity default is 1/6 of this. */
export const FLY_SPEED_ZONE = 25;
export const FLY_SPEED_ENTITY = FLY_SPEED_ZONE / 6; // ≈ 4.17

function loadFlySpeed(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v)) : fallback;
  } catch {
    return fallback;
  }
}

export class OrbitCamera {
  constructor() {
    this.mode = 'orbit';          // 'orbit' | 'fly'
    this.yUp = false;            // false = FFXI entity Y-down; true = zone/editor Y-up
    this.rangeKind = 'entity';    // 'zone' | 'entity' — picks default fly speed
    this.target = [0, 0, 0];
    this.yaw = 0.6;
    this.pitch = 0.3;
    this.distance = 5;
    this.fovDegrees = 45;
    this.minDistance = 0.1;
    this.maxDistance = 500;
    this.near = 0.05;
    this.far = 1000;
    // Fly state — separate remembered speeds per context
    this.pos = [0, 0, 5];
    this.flySpeedZone = loadFlySpeed('flySpeedZone', FLY_SPEED_ZONE);
    this.flySpeedEntity = loadFlySpeed('flySpeedEntity', FLY_SPEED_ENTITY);
    this.flySpeed = this.flySpeedEntity;
  }

  get up() {
    return this.yUp ? [0, 1, 0] : [0, -1, 0];
  }

  /** Unit look direction for fly mode (pitch > 0 = look "up" on screen). */
  get lookDir() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const y = this.yUp ? sp : -sp;
    return [
      cp * Math.sin(this.yaw),
      y,
      cp * Math.cos(this.yaw),
    ];
  }

  get eye() {
    if (this.mode === 'fly') return this.pos;
    // Orbit: eye on a sphere around target (legacy entity framing preserved).
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const yOff = this.yUp ? sp : -sp;
    return [
      this.target[0] + cp * Math.sin(this.yaw) * this.distance,
      this.target[1] + yOff * this.distance,
      this.target[2] + cp * Math.cos(this.yaw) * this.distance,
    ];
  }

  get forward() {
    if (this.mode === 'fly') return this.lookDir;
    const e = this.eye;
    return norm([this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]]);
  }

  viewMatrix() {
    if (this.mode === 'fly') {
      const e = this.pos;
      const f = this.lookDir;
      return mat4LookAt(e, [e[0] + f[0], e[1] + f[1], e[2] + f[2]], this.up);
    }
    return mat4LookAt(this.eye, this.target, this.up);
  }

  projectionMatrix(aspect) {
    const far = Math.max(this.far, (this.mode === 'fly' ? this.flySpeed * 40 : this.distance * 8) + 50);
    const near = Math.min(this.near, Math.max((this.mode === 'fly' ? this.flySpeed : this.distance) * 0.0005, 0.05));
    return mat4Perspective((this.fovDegrees * Math.PI) / 180, aspect, near, far);
  }

  orbit(dx, dy) {
    this.yaw += dx * 0.01;
    this.pitch = Math.min(Math.max(this.pitch + dy * 0.01, -1.55), 1.55);
  }

  /**
   * Fly look. Y-up (zones) matches the level editor: drag right → look right.
   * Y-down (entities) needs the opposite yaw sign because up is flipped and
   * otherwise left/right invert.
   */
  flyLook(dx, dy) {
    const sens = 0.0026;
    const yawSign = this.yUp ? -1 : 1;
    this.yaw += yawSign * dx * sens;
    this.pitch = Math.min(Math.max(this.pitch - dy * sens, -1.55), 1.55);
  }

  pan(dx, dy) {
    const f = this.forward;
    const right = norm(cross(f, this.up));
    const up = cross(right, f);
    const s = this.distance * 0.0015;
    this.target = [
      this.target[0] - right[0] * dx * s + up[0] * dy * s,
      this.target[1] - right[1] * dx * s + up[1] * dy * s,
      this.target[2] - right[2] * dx * s + up[2] * dy * s,
    ];
  }

  zoom(wheelDelta) {
    this.distance = Math.min(
      Math.max(this.distance * Math.pow(0.999, wheelDelta), this.minDistance),
      this.maxDistance,
    );
  }

  setFlySpeed(v) {
    this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v));
    if (this.rangeKind === 'zone') {
      this.flySpeedZone = this.flySpeed;
      try { localStorage.setItem('flySpeedZone', String(this.flySpeed)); } catch { /* quota */ }
    } else {
      this.flySpeedEntity = this.flySpeed;
      try { localStorage.setItem('flySpeedEntity', String(this.flySpeed)); } catch { /* quota */ }
    }
  }

  /** Wheel adjusts fly speed (level editor: ×1.15 per notch). */
  adjustFlySpeed(direction) {
    this.setFlySpeed(this.flySpeed * Math.pow(1.15, direction));
  }

  /**
   * WASD/QE fly move. `keys` is a Set of lowercase key names; shift boosts ×3.
   * Matches leveleditor fly-camera.js (WORLD_UP vertical, forward/right planar).
   */
  flyUpdate(dt, keys) {
    if (this.mode !== 'fly') return;
    const fwd = this.lookDir;
    const up = this.up;
    const right = norm(cross(fwd, up));
    let mx = 0, my = 0, mz = 0;
    if (keys.has('w')) { mx += fwd[0]; my += fwd[1]; mz += fwd[2]; }
    if (keys.has('s')) { mx -= fwd[0]; my -= fwd[1]; mz -= fwd[2]; }
    if (keys.has('d')) { mx += right[0]; my += right[1]; mz += right[2]; }
    if (keys.has('a')) { mx -= right[0]; my -= right[1]; mz -= right[2]; }
    if (keys.has('e')) { mx += up[0]; my += up[1]; mz += up[2]; }
    if (keys.has('q')) { mx -= up[0]; my -= up[1]; mz -= up[2]; }
    const len = Math.hypot(mx, my, mz);
    if (len < 1e-8) return;
    const boost = (keys.has('shift') ? 3 : 1);
    const s = (this.flySpeed * boost * dt) / len;
    this.pos = [this.pos[0] + mx * s, this.pos[1] + my * s, this.pos[2] + mz * s];
  }

  /** Entity-scale defaults, or zone-scale when `kind === 'zone'`. */
  setRangeFor(kind) {
    this.rangeKind = kind === 'zone' ? 'zone' : 'entity';
    if (this.rangeKind === 'zone') {
      this.yUp = true;
      this.minDistance = 1;
      this.maxDistance = 20000;
      this.near = 0.5;
      this.far = 5000;
      this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, this.flySpeedZone));
    } else {
      this.yUp = false;
      this.minDistance = 0.1;
      this.maxDistance = 500;
      this.near = 0.05;
      this.far = 1000;
      this.flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, this.flySpeedEntity));
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    if (mode === 'fly') {
      // Enter fly at the current orbit eye, looking at the orbit target.
      const e = this.eye;
      const f = this.forward;
      this.pos = [e[0], e[1], e[2]];
      this.yaw = Math.atan2(f[0], f[2]);
      const horiz = Math.hypot(f[0], f[2]) || 1e-6;
      this.pitch = this.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
      this.mode = 'fly';
    } else {
      // Drop an orbit target ahead of the fly camera.
      const f = this.lookDir;
      const dist = Math.min(Math.max(this.distance, 5), this.maxDistance);
      this.target = [
        this.pos[0] + f[0] * dist,
        this.pos[1] + f[1] * dist,
        this.pos[2] + f[2] * dist,
      ];
      this.distance = dist;
      this.mode = 'orbit';
    }
  }

  /** Frame an AABB. Optional `opts.distance` overrides the auto radius framing. */
  fit(min, max, opts = {}) {
    this.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 0.5);
    this.distance = opts.distance != null
      ? Math.min(Math.max(opts.distance, this.minDistance), this.maxDistance)
      : Math.min(Math.max(radius * 2.4, this.minDistance), this.maxDistance);
    this.yaw = opts.yaw ?? 0.6;
    this.pitch = opts.pitch ?? 0.3;
    if (this.mode === 'fly') {
      // Seat fly camera on the fitted orbit eye, looking at the target.
      const cp = Math.cos(this.pitch);
      const sp = Math.sin(this.pitch);
      const yOff = this.yUp ? sp : -sp;
      this.pos = [
        this.target[0] + cp * Math.sin(this.yaw) * this.distance,
        this.target[1] + yOff * this.distance,
        this.target[2] + cp * Math.cos(this.yaw) * this.distance,
      ];
      const f = norm([
        this.target[0] - this.pos[0],
        this.target[1] - this.pos[1],
        this.target[2] - this.pos[2],
      ]);
      this.yaw = Math.atan2(f[0], f[2]);
      const horiz = Math.hypot(f[0], f[2]) || 1e-6;
      this.pitch = this.yUp ? Math.atan2(f[1], horiz) : Math.atan2(-f[1], horiz);
    }
  }
}
