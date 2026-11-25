import { WOBBLE_BEND, WOBBLE_BIAS } from '../core/geometry/hand-drawn';
import { INSTANCE_QUADS } from '../core/geometry/branch-instances';
import { SHADOW_FALL } from '../core/geometry/relief';

// All shaders work in "camera-relative screen space": the CPU subtracts the camera centre (in doubles)
// before data reaches the GPU, so float32 precision is only spent on what is near the viewport.

export const MESH_VS = `#version 300 es
precision highp float;
uniform vec2 u_view;
uniform float u_zoom;
uniform vec2 u_off; // (meshOrigin - cameraCentre), computed in double precision on the CPU
uniform vec2 u_off_low;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_col;
layout(location=2) in vec2 a_pos_low;
out vec4 v_col;
void main() {
  // Keep the cancelling high terms together on shader backends that reassociate float additions.
  // The low bit of their local difference is below framebuffer precision.
  vec2 local_high = intBitsToFloat(floatBitsToInt(a_pos + u_off) & ivec2(-2));
  vec2 p = (local_high + (a_pos_low + u_off_low)) * u_zoom;
  gl_Position = vec4(p.x / (u_view.x * 0.5), -p.y / (u_view.y * 0.5), 0.0, 1.0);
  v_col = a_col;
}`;

export const MESH_FS = `#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`;

// GPU-expanded branches (core/geometry/branch-instances.ts): each instance is one chunk of INSTANCE_QUADS quads of a
// branch's strip; the branch's record is read from u_rec (RGBA32UI, u_stride texels per record, 2048 texels per row) and
// the strip point is rebuilt exactly as instanceVertices does (and tessellateBatch / reliefBatch before it). Compiled
// three ways: flat (MESH_FS), and with RELIEF defined, lit (RELIEF_FS, or ROPE_FS with ROPE) or, with SHADOW too, moved
// to its shadow for the shadow layer (RELIEF_SHADOW_FS), with the varyings of RELIEF_VS / ROPE_VS / RELIEF_SHADOW_VS.
const BRANCH_INSTANCE_BODY = `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_rec;
uniform int u_stride;
uniform vec2 u_view;
uniform float u_zoom;
uniform vec2 u_off; // -camera centre as float32 and its residual: records hold exact world positions
uniform vec2 u_off_low;
uniform bool u_coarse;
#ifdef SHADOW
uniform float u_coded;
#endif
layout(location=0) in uint a_chunk; // branch << 8 | chunk
out vec4 v_col;
#ifdef RELIEF
out vec4 v_n;
#ifdef ROPE
out float v_twist;
flat out float v_plies;
#endif
#endif
const int QUADS = ${INSTANCE_QUADS};
const float PI = 3.141592653589793;
const vec2 FALL = vec2(${SHADOW_FALL.x}, ${SHADOW_FALL.y});
int base;
uvec4 recu(int i) { int t = base + i; return texelFetch(u_rec, ivec2(t & 2047, t >> 11), 0); }
vec4 rec(int i) { return uintBitsToFloat(recu(i)); }
vec4 rgba(uint c) { return vec4(uvec4(c, c >> 8, c >> 16, c >> 24) & 255u) / 255.0; }
int ribbonSteps(int m) { return u_coarse && m >= 2 ? (m + 7) / 8 : m; }
int fanSteps(int m) { return u_coarse && m >= 4 ? (m + 1) / 2 : m; }
int dotCorners(int m) { return u_coarse && m - 1 >= 4 ? m / 2 + 1 : m; }
vec2 unit(vec2 v, vec2 chord) {
  float l = length(v);
  if (l < 1e-6) {
    v = chord;
    l = length(v);
    if (l < 1e-6) return vec2(1.0, 0.0);
  }
  return v / l;
}
// One vertex: position relative to p0, colour, and its lighting (normal, strength, across, shadow offset, twist).
vec2 P;
vec4 C;
vec4 N;
vec2 SH;
float TW;
void lit(vec2 m, float k, float across, vec2 shadow, float twist) { N = vec4(m, k, across); SH = shadow; TW = twist; }
// Edge vertex of a ribbon-like point: centre c, unit normal m (side 1 takes -m), half width hw.
void edge(vec2 c, vec2 m, float hw, int side, float k, float twist) {
  vec2 s = side == 0 ? m : -m;
  P = c + s * hw;
  lit(s, k, side == 0 ? 1.0 : -1.0, FALL * (hw * 1.1 + 1.0) + s * (hw * 0.5 + 2.0), twist);
}
// Disk point: centre c, radius r, unit direction m from it (rim) or the centre itself (rim false).
void dome(vec2 c, float r, vec2 m, bool rim, float k, float twist) {
  vec2 fall = FALL * (r * 1.1 + 1.0);
  if (rim) { P = c + m * r; lit(m, k, 1.0, fall + m * (r * 0.5 + 2.0), twist); }
  else { P = c; lit(vec2(0.0), k, 0.0, fall, twist); }
}
void main() {
  base = int(a_chunk >> 8) * u_stride;
  vec4 r1 = rec(1), r2 = rec(2);
  uvec4 r3 = recu(3);
  vec4 r4 = rec(4), r5 = rec(5), r6 = rec(6);
  int n = int(r3.z & 255u), S = int((r3.z >> 8) & 255u), U = int((r3.z >> 16) & 255u), Se = int(r3.z >> 24);
  int D = int(r3.w & 255u);
  uint flags = r3.w >> 8;
  bool straight = (flags & 1u) != 0u, joined = (flags & 2u) != 0u, organic = (flags & 4u) != 0u;
  bool elbow = (flags & 8u) != 0u, fans = (flags & 32u) != 0u;
  int n2 = ribbonSteps(n), S2 = fanSteps(S), U2 = ribbonSteps(U), Se2 = fanSteps(Se), m = dotCorners(D);
  // Points per piece and the pieces that start after two break points (see branch-instances.ts piecePoints).
  int pts[6];
  pts[0] = fans ? S2 + 1 : S2 >> 1;
  pts[1] = n2 + 1;
  pts[2] = U > 0 ? U2 + (joined ? 0 : 1) : 0;
  pts[3] = (flags & 64u) != 0u ? 2 : 0;
  pts[4] = Se > 0 ? (fans ? Se2 + 1 : Se2 >> 1) : 0;
  pts[5] = D > 0 ? (fans ? m + 1 : (m >> 1) + 1) : 0;
  int breaks = (fans ? 2 | 16 : 0) | (U > 0 && !joined ? 4 : 0) | 8 | 32;
  int g = int(a_chunk & 255u) * QUADS + (gl_VertexID >> 1);
  int side = gl_VertexID & 1;
  int kind = -1, idx = 0, prev = 0;
  for (int k = 0; k < 6; k++) {
    int c = pts[k];
    if (c == 0) continue;
    if ((breaks & (1 << k)) != 0 && k > 0) {
      if (g < 2) {
        if (g == 0) { kind = prev; idx = pts[prev] - 1; side = 1; } else { kind = k; idx = 0; side = 0; }
        break;
      }
      g -= 2;
    }
    if (g < c) { kind = k; idx = g; break; }
    g -= c;
    prev = k;
  }
  if (kind < 0) { kind = prev; idx = pts[prev] - 1; }
  vec2 c1 = r1.xy, c2 = r1.zw, p1 = r2.xy;
  float w0 = r2.z, w1 = r2.w;
  vec4 colA = rgba(r3.x), colB = rgba(r3.y);
  float ribK = 0.0, capK = 0.0, turn0 = 0.0, limb = 0.0, lay = 1.0, span = 0.0;
  if (fans) {
    vec4 r8 = rec(8), r9 = rec(9);
    ribK = r8.x; capK = r8.y; turn0 = r8.z; limb = r8.w; lay = r9.x; span = r9.y;
  }
  float turnEnd = turn0 + (limb + span) / lay;
  C = colB;
  N = vec4(0.0);
  SH = vec2(0.0);
  TW = 0.0;
  if (kind == 1 || kind == 2) {
    if (kind == 1) {
      int j = u_coarse && n >= 2 ? min(8 * idx, n) : idx;
      float t = float(j) / float(n), v = 1.0 - t;
      vec2 p = 3.0 * v * v * t * c1 + 3.0 * v * t * t * c2 + t * t * t * p1;
      vec2 tg = straight ? p1 : 3.0 * (v * v * c1 + 2.0 * v * t * (c2 - c1) + t * t * (p1 - c2));
      float join = 1.0;
      if (elbow) {
        // 'angular': corners 0, e1, e2, p1; tangents from the signs of both legs; mitred inner corners.
        bool fv = (flags & 16u) != 0u;
        vec2 e1 = fv ? vec2(0.0, p1.y * 0.5) : vec2(p1.x * 0.5, 0.0);
        vec2 e2 = fv ? vec2(p1.x, p1.y * 0.5) : vec2(p1.x * 0.5, p1.y);
        p = j == 0 ? vec2(0.0) : j == 1 ? e1 : j == 2 ? e2 : p1;
        vec2 a = j <= 1 ? vec2(0.0) : j == 2 ? e1 : e2;
        vec2 b = j == 0 ? e1 : j == 1 ? e2 : p1;
        tg = sign(p - a) + sign(b - p);
        if (j == 1 || j == 2) join = sqrt(2.0);
      }
      tg = unit(tg, p1);
      float w = w0 + (w1 - w0) * t;
      if (organic) {
        vec4 r7 = rec(7);
        w *= 1.0 + r7.z * sin(PI * t) * sin(r7.y * 2.0 * PI * t + r7.x);
      }
      edge(p, vec2(-tg.y, tg.x), w * 0.5 * join, side, ribK, turn0 + t * limb / lay);
      // The CPU mesh stores each vertex's blended colour as unorm8.
      C = round(mix(colA, colB, t) * 255.0) / 255.0;
    } else {
      int j = joined ? idx + 1 : idx;
      j = u_coarse && U >= 2 ? min(8 * j, U) : j;
      float t = float(j) / float(U);
      vec2 uv = r5.xy;
      float rise = r5.w;
      float x = p1.x + uv.x * t;
      float y = p1.y + uv.y * t + (rise != 0.0 ? (cos(2.0 * PI * t) - 1.0) * rise * 0.5 : 0.0);
      float dyBar = uv.y + (rise != 0.0 ? -PI * rise * sin(2.0 * PI * t) : 0.0);
      float len = length(vec2(uv.x, dyBar));
      if (len == 0.0) len = 1.0;
      edge(vec2(x, y), vec2(-dyBar, uv.x) / len, r5.z, side, ribK, turn0 + (limb + span * t) / lay);
    }
  } else if (kind == 0 || kind == 4) {
    // Half-disk caps: zig-zag arc pairs (flat) or centre/arc fans (FANS), arc indices in coarse step space.
    bool start = kind == 0;
    int steps = start ? S : Se, coarseSteps = start ? S2 : Se2;
    bool rim = true;
    int q;
    if (fans) { rim = side == 1; q = idx; }
    else if (start) { int p = pts[0] - idx; q = side == 0 ? p : coarseSteps - p; }
    else q = side == 0 ? idx + 1 : coarseSteps - idx - 1;
    int k = u_coarse && steps >= 4 ? min(2 * q, steps) : q;
    vec2 c = start ? vec2(0.0) : p1 + r5.xy;
    vec2 tg = start ? r4.xy : r4.zw;
    float a = PI * float(k) / float(steps);
    vec2 dir = cos(a) * vec2(-tg.y, tg.x) + sin(a) * (start ? -tg : tg);
    dome(c, start ? w0 * 0.5 : r6.x, dir, rim, capK, start ? turn0 : turnEnd);
    C = start ? colA : colB;
  } else if (kind == 5) {
    // Tip dot: zig-zag corner pairs (flat) or centre/corner fans closing on corner 0 (FANS).
    bool rim = true;
    int q;
    if (fans) { rim = side == 1; q = idx == m ? 0 : idx; }
    else q = side == 0 || idx == 0 ? idx : m - idx;
    int k = u_coarse && D - 1 >= 4 ? min(2 * q, D - 1) : q;
    float a = 2.0 * PI * float(k) / float(D);
    dome(r6.zw, r6.y, vec2(cos(a), sin(a)), rim, capK, turnEnd);
  } else {
    // 'rope' whipping: one quad across the bundle where it divides.
    vec4 r9 = rec(9), r10 = rec(10);
    float reach = idx == 0 ? -7.0 : r10.w;
    vec2 tg = r10.xy, c = r9.zw + tg * reach;
    vec2 s = side == 0 ? vec2(-tg.y, tg.x) : vec2(tg.y, -tg.x);
    P = c + s * r10.z;
    lit(s, (112.0 + 0.5) / 127.0, side == 0 ? 1.0 : -1.0, vec2(0.0), float(idx));
    C = rgba(recu(11).x);
  }
  vec4 r0 = rec(0);
  vec2 local = P;
#ifdef RELIEF
  // As the CPU mesh stores them: int8 / 127 (truncated), shadow offsets int16 / 128 world units.
  vec4 n8 = trunc(N * 127.0) / 127.0;
#ifdef SHADOW
  local += trunc(SH * 128.0) / 128.0;
  v_n = n8;
  if (u_coded > 0.5) v_n.z = float(int(round(n8.z * 127.0)) & 15) / 15.0;
#else
  v_n = n8;
#ifdef ROPE
  v_twist = TW;
  v_plies = float(int(round(n8.z * 127.0)) >> 4);
#endif
#endif
#endif
  vec2 local_high = intBitsToFloat(floatBitsToInt(r0.xy + u_off) & ivec2(-2));
  vec2 p = (local_high + (r0.zw + u_off_low) + local) * u_zoom;
  gl_Position = vec4(p.x / (u_view.x * 0.5), -p.y / (u_view.y * 0.5), 0.0, 1.0);
  v_col = C;
}`;
const variant = (defines: string) => '#version 300 es\n' + defines + BRANCH_INSTANCE_BODY;
export const BRANCH_INSTANCE_VS = variant('');
export const BRANCH_RELIEF_VS = variant('#define RELIEF\n');
export const BRANCH_ROPE_VS = variant('#define RELIEF\n#define ROPE\n');
export const BRANCH_SHADOW_VS = variant('#define RELIEF\n#define SHADOW\n');

// Dimensional branch meshes (core/geometry/relief.ts). Same transform as MESH_VS plus a_nrm = (nx, ny, shadow strength,
// across): nx, ny the in-plane part of the surface normal in world axes; across -1..1 over a ribbon, 0..1 up a quilled
// wall. The shadow layer draws the same vertex stream with RELIEF_SHADOW_VS (see Renderer.uploadRelief).
export const RELIEF_VS = `#version 300 es
precision highp float;
uniform vec2 u_view;
uniform float u_zoom;
uniform vec2 u_off;
uniform vec2 u_off_low;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_col;
layout(location=2) in vec2 a_pos_low;
layout(location=3) in vec4 a_nrm;
out vec4 v_col;
out vec4 v_n;
void main() {
  vec2 local_high = intBitsToFloat(floatBitsToInt(a_pos + u_off) & ivec2(-2));
  vec2 p = (local_high + (a_pos_low + u_off_low)) * u_zoom;
  gl_Position = vec4(p.x / (u_view.x * 0.5), -p.y / (u_view.y * 0.5), 0.0, 1.0);
  v_col = a_col;
  v_n = a_nrm;
}`;

// Shadow layer vertex: the same stream with each vertex moved to its shadow (a_soff, in 1/128 world units). With
// u_coded (rope) the strength byte also carries the ply count: strength is its low 4 bits.
export const RELIEF_SHADOW_VS = RELIEF_VS
  .replace('layout(location=3) in vec4 a_nrm;', 'layout(location=3) in vec4 a_nrm;\nlayout(location=4) in vec2 a_soff;\nuniform float u_coded;')
  .replace('vec2 p = (local_high + (a_pos_low + u_off_low)) * u_zoom;',
    'vec2 p = (local_high + (a_pos_low + u_off_low) + a_soff * 0.0078125) * u_zoom;')
  .replace('v_n = a_nrm;', 'v_n = a_nrm;\n  if (u_coded > 0.5) v_n.z = float(int(round(a_nrm.z * 127.0)) & 15) / 15.0;');

// 'rope': the twist phase (turns) as well, and the ply count from the strength byte's high bits.
export const ROPE_VS = RELIEF_VS
  .replace('layout(location=3) in vec4 a_nrm;', 'layout(location=3) in vec4 a_nrm;\nlayout(location=5) in float a_twist;')
  .replace('out vec4 v_n;', 'out vec4 v_n;\nout float v_twist;\nflat out float v_plies;')
  .replace('v_n = a_nrm;', 'v_n = a_nrm;\n  v_twist = a_twist;\n  v_plies = float(int(round(a_nrm.z * 127.0)) >> 4);');

// Lit ribbon: v_n.xy is the in-plane normal (length 1 on the silhouette), so the surface normal is (n, sqrt(1 - |n|^2)).
// One fixed light from the upper left (core/geometry/relief.ts LIGHT). u_mat = ambient, diffuse, specular, shininess.
export const RELIEF_FS = `#version 300 es
precision mediump float;
uniform vec4 u_mat;
in vec4 v_col;
in vec4 v_n;
out vec4 o;
const vec3 L = vec3(-0.24, -0.5, 0.83);
const vec3 H = vec3(-0.1255, -0.2615, 0.9570); // normalize(L + view)
void main() {
  vec2 n = v_n.xy;
  float q = min(dot(n, n), 1.0);
  vec3 N = vec3(n, sqrt(1.0 - q));
  float lambert = max(dot(N, L), 0.0);
  float spec = u_mat.z * pow(max(dot(N, H), 0.0), u_mat.w);
  o = vec4(min(v_col.rgb * (u_mat.x + u_mat.y * lambert) + spec * v_col.a, vec3(v_col.a)), v_col.a);
}`;

// 'rope': the bundle ribbon drawn as N plies twisting round it. Across the ribbon a = sin(angle round the bundle); the
// ply coordinate u = (angle / 2pi + twist) * N runs diagonally, so each ply is a diagonal band with its own rounded
// normal, a seam between plies and a slightly different shade. The detail fades out before it aliases (fwidth of u).
// Caps and beads have N = 0 and are lit as plain surfaces; N = 7 is a whipping, plain with thread lines across it
// (v_twist runs 0 to 1 along it).
export const ROPE_FS = `#version 300 es
precision highp float;
uniform vec4 u_mat;
in vec4 v_col;
in vec4 v_n;
in float v_twist;
flat in float v_plies;
out vec4 o;
const vec3 L = vec3(-0.24, -0.5, 0.83);
const vec3 H = vec3(-0.1255, -0.2615, 0.9570);
void main() {
  vec2 n = v_n.xy;
  vec3 N = vec3(n, sqrt(max(0.0, 1.0 - min(dot(n, n), 1.0))));
  vec3 col = v_col.rgb;
  float plies = v_plies;
  float seam = 0.0;
  if (plies > 6.5) {
    float tt = v_twist * 9.0;
    float groove = smoothstep(0.55, 1.0, abs(fract(tt) * 2.0 - 1.0)) * (1.0 - smoothstep(0.25, 0.5, fwidth(tt)));
    col *= 1.0 - 0.3 * groove;
    plies = 0.0;
  }
  if (plies > 0.5) {
    float u = (asin(clamp(v_n.w, -0.98, 0.98)) * 0.15915494 + v_twist) * plies;
    float detail = 1.0 - smoothstep(0.35, 0.7, fwidth(u));
    if (detail > 0.0) {
      float f = fract(u) * 2.0 - 1.0;
      vec2 g = vec2(dFdx(u), -dFdy(u));
      float g2 = dot(g, g);
      vec2 across = g2 > 1e-12 ? g * inversesqrt(g2) : vec2(0.0);
      N = normalize(N + vec3(across * (f * 0.85 * detail), 0.0));
      float tint = fract(sin(mod(floor(u), plies) * 12.9898 + 4.1) * 43758.5453) - 0.5;
      col *= 1.0 + 0.16 * tint * detail;
      seam = detail * smoothstep(0.55, 1.0, abs(f));
    }
  }
  float lambert = max(dot(N, L), 0.0);
  float spec = u_mat.z * pow(max(dot(N, H), 0.0), u_mat.w);
  vec3 c = col * (u_mat.x + u_mat.y * lambert) * (1.0 - 0.42 * seam) + spec * (1.0 - seam) * v_col.a;
  o = vec4(min(c, vec3(v_col.a)), v_col.a);
}`;

// 'quilling': a paper wall whose face shading is baked into the colour; across runs 0 at its foot to 1 on its top edge.
// The top edge (the paper's lit thickness, 7% of the wall and at least about a pixel) is light, and the face darkens a
// little toward the ground. A negative across marks a leaf's scroll (core/geometry/quill.ts): v_n.xy are its local
// coordinates (x mirrored by the sign of v_n.z) and the spiral wall is found per pixel. u_far: walls under a pixel high,
// drawn flat (and the scroll as a small disc).
export const QUILL_FS = `#version 300 es
precision highp float;
uniform float u_far;
in vec4 v_col;
in vec4 v_n;
out vec4 o;
const float TAU = 6.2831853;
const float TURNS = 2.0;
const float K = 0.8 / (TAU * TURNS); // the radius falls from 1 to 0.2 over the turns
// First crossing of the ray p - s F (s from the top edge down to the foot) with the spiral's top edge: (found, s).
// Coil n of the spiral passes through q where ((1 - |q|) / K - angle) / TAU = n.
vec2 spiral(vec2 p, vec2 F) {
  float before = 0.0;
  for (int j = 0; j <= 12; j++) {
    float s = float(j) / 12.0;
    vec2 q = p - s * F;
    float angle = mod(1.5707963 - atan(q.y, q.x), TAU);
    float c = ((1.0 - length(q)) / K - angle) / TAU;
    // Across the angle's seam c jumps by a whole turn: carry the previous value over before comparing.
    float b = before + floor(c - before + 0.5);
    if (j > 0 && floor(c) != floor(b)) {
      float n = floor(max(c, b));
      if (n >= 0.0 && angle + TAU * n <= TAU * TURNS) return vec2(1.0, (float(j - 1) + (n - b) / (c - b)) / 12.0);
    }
    before = c;
  }
  return vec2(0.0);
}
void main() {
  if (v_n.w >= 0.0) {
    if (u_far > 0.5) {
      o = v_col;
      return;
    }
    float a = clamp(v_n.w, 0.0, 1.0);
    float w = fwidth(a);
    float e = max(0.07, 0.9 * w);
    float top = 1.0 - smoothstep(e, e + w, 1.0 - a);
    vec3 face = v_col.rgb * mix(0.74, 1.0, a * a);
    vec3 edge = min(vec3(v_col.a), v_col.rgb * 1.25 + 0.34 * v_col.a);
    o = vec4(mix(face, edge, top), v_col.a);
    return;
  }
  float m = v_n.z < 0.0 ? -1.0 : 1.0;
  vec2 p = v_n.xy * 2.5;
  if (u_far > 0.5) {
    o = v_col * (1.0 - smoothstep(0.7, 0.9, length(p)));
    return;
  }
  vec2 F = vec2(-0.48 * m, 0.8);
  vec2 hit = spiral(p, F);
  if (hit.x < 0.5) {
    o = vec4(0.0);
    return;
  }
  float a = 1.0 - hit.y;
  vec2 rho = normalize(p - hit.y * F + 1e-6);
  // The face we see, lit by its facing; the inside of a coil darker.
  vec2 nf = dot(rho, vec2(-0.6 * m, 1.0)) >= 0.0 ? rho : -rho;
  float shade = (0.86 + 0.22 * dot(nf, vec2(-0.433 * m, -0.901))) * (dot(nf, rho) < 0.0 ? 0.82 : 1.05);
  float px = length(fwidth(p)) / length(F);
  float e = max(0.07, 1.2 * px);
  float top = 1.0 - smoothstep(e, e + px, 1.0 - a);
  vec3 face = v_col.rgb * shade * mix(0.74, 1.0, a * a);
  vec3 edge = v_col.rgb * 1.25 + 0.34 * v_col.a;
  o = vec4(min(mix(face, edge, top), vec3(v_col.a)), v_col.a) * smoothstep(0.0, px, a);
}`;

// Shadow layer: single channel, blended with MAX so crossing shadows never darken twice. Darkest where |across| = 0
// (a ribbon's centre line, a wall's foot), fading to nothing at |across| = 1; v_n.z is the strength.
export const RELIEF_SHADOW_FS = `#version 300 es
precision mediump float;
in vec4 v_col;
in vec4 v_n;
out vec4 o;
void main() {
  o = vec4(abs(v_n.z) * (1.0 - smoothstep(0.2, 1.0, abs(v_n.w))));
}`;

// Composite of the shadow layer over the page: one full-screen pass (GRID_VS) with a premultiplied colour.
export const RELIEF_COMPOSITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec4 u_color;
out vec4 o;
void main() {
  o = u_color * texture(u_tex, gl_FragCoord.xy / u_res).r;
}`;

// Instanced rounded rectangles. Per instance: box (x,y,w,h camera-relative world), misc (radius, strokeWidth world),
// fill and stroke as premultiplied RGBA. Instances kept on the GPU between frames (the whole map in view) hold x, y
// relative to an origin instead, with their float32 residual in a_low, and the camera arrives as u_off + u_off_low
// (origin - camera, split in double precision on the CPU); per-frame instances leave all three at 0. Boxes smaller than
// u_min world units both ways are not drawn (0 draws everything).
const PLACE = `uniform vec2 u_off;
uniform vec2 u_off_low;
uniform float u_min;
layout(location=5) in vec2 a_low;`;
const PLACE_SKIP = `if (a_box.z < u_min && a_box.w < u_min) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 box_xy = (a_box.xy + u_off) + (a_low + u_off_low);`;

export const RECT_VS = `#version 300 es
precision highp float;
uniform vec2 u_view;
uniform float u_zoom;
${PLACE}
layout(location=0) in vec4 a_box;
layout(location=1) in vec2 a_misc;
layout(location=2) in vec4 a_fill;
layout(location=3) in vec4 a_stroke;
layout(location=4) in vec2 a_wobble;
out vec2 v_p;
flat out vec2 v_half;
flat out vec2 v_rs;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out vec2 v_wobble;
void main() {
  ${PLACE_SKIP}
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 half_ = a_box.zw * 0.5 * u_zoom;
  vec2 c = (box_xy + a_box.zw * 0.5) * u_zoom;
  vec2 e = half_ + abs(a_wobble) * u_zoom + vec2(1.5);
  vec2 l = (q * 2.0 - 1.0) * e;
  vec2 corner = c + l;
  gl_Position = vec4(corner.x / (u_view.x * 0.5), -corner.y / (u_view.y * 0.5), 0.0, 1.0);
  v_p = l;
  v_half = half_;
  float sw = a_misc.y > 0.0 ? max(a_misc.y * u_zoom, 1.0) : 0.0;
  v_rs = vec2(a_misc.x * u_zoom, sw);
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_wobble = a_wobble * u_zoom;
}`;

export const RECT_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec2 v_half;
flat in vec2 v_rs;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in vec2 v_wobble;
out vec4 o;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float bend(float value) {
  float t = clamp(value, -1.0, 1.0);
  return t * (1.0 - ${WOBBLE_BEND} * t * t) + ${WOBBLE_BIAS} * t * t;
}
void main() {
  float r = min(v_rs.x, min(v_half.x, v_half.y));
  vec2 p = v_p;
  if (v_wobble.x != 0.0 || v_wobble.y != 0.0) {
    p.y -= v_wobble.y * bend(p.x / max(v_half.x, 0.01));
    p.x -= v_wobble.x * bend(p.y / max(v_half.y, 0.01));
  }
  float d = sdBox(p, v_half, r);
  float cov = clamp(0.5 - d, 0.0, 1.0);
  vec4 col = v_fill * cov;
  if (v_rs.y > 0.0) {
    float inner = clamp(0.5 - (d + v_rs.y), 0.0, 1.0);
    vec4 s = v_stroke * (cov * (1.0 - inner));
    col = s + col * (1.0 - s.a);
  }
  o = col;
}`;

// Clay tablets (Scene.raisedRects): RECT_FS with a raised rim on the fill, lit by the relief light from the upper
// left (lighter on the edges facing it, darker on the others). A separate program, so plain rectangles are unchanged.
export const RECT_RAISED_FS = RECT_FS.replace('out vec4 o;', `out vec4 o;
vec2 edgeNormal(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 g = q.x > 0.0 || q.y > 0.0 ? normalize(max(q, vec2(0.0))) : q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  return g * sign(p);
}`).replace('vec4 col = v_fill * cov;', `vec4 col = v_fill * cov;
  float rim = min(v_half.x, v_half.y) * 0.5;
  float edge = 1.0 - smoothstep(0.0, rim, -d);
  float facing = dot(edgeNormal(p, v_half, r), vec2(-0.433, -0.901));
  col.rgb = clamp(col.rgb + col.a * edge * edge * 0.16 * facing, 0.0, col.a);`);

// The coarse placeholder uses the textured quad's instance layout. Each corner
// carries its own packed RGBA colour in place of the four UV coordinates.
export const COARSE_BLUR_VS = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_view;
uniform float u_zoom;
layout(location=0) in vec4 a_rect;
layout(location=1) in vec4 a_corners;
layout(location=2) in float a_opacity;
out vec4 v_col;
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = (a_rect.xy + q * a_rect.zw) * u_zoom;
  gl_Position = vec4(p.x / (u_view.x * 0.5), -p.y / (u_view.y * 0.5), 0.0, 1.0);
  int color = int(a_corners[gl_VertexID]);
  vec4 rgba = vec4(color & 63, (color >> 6) & 63, (color >> 12) & 63, color >> 18) / 63.0;
  v_col = vec4(rgba.rgb * rgba.a, rgba.a) * a_opacity;
}`;

// Instanced quads for labels and pictures.
export const TEX_VS = `#version 300 es
precision highp float;
uniform vec2 u_view;
uniform float u_zoom;
layout(location=0) in vec4 a_rect; // x,y,w,h camera-relative world
layout(location=1) in vec4 a_uv;   // u0,v0,u1,v1
layout(location=2) in float a_opacity;
layout(location=3) in vec3 a_turn; // angle (radians), pivot x, y camera-relative world
out vec2 v_uv;
flat out vec4 v_uvBounds;
out float v_opacity;
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 w = a_rect.xy + q * a_rect.zw;
  if (a_turn.x != 0.0) {
    float c = cos(a_turn.x), s = sin(a_turn.x);
    vec2 d = w - a_turn.yz;
    w = a_turn.yz + vec2(d.x * c - d.y * s, d.x * s + d.y * c);
  }
  vec2 p = w * u_zoom;
  gl_Position = vec4(p.x / (u_view.x * 0.5), -p.y / (u_view.y * 0.5), 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, q);
  v_uvBounds = a_uv;
  v_opacity = a_opacity;
}`;

export const TEX_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform bool u_clampUV;
in vec2 v_uv;
flat in vec4 v_uvBounds;
in float v_opacity;
out vec4 o;
void main() {
  vec2 uv = v_uv;
  if (u_clampUV) {
    vec2 halfTexel = 0.5 / vec2(textureSize(u_tex, 0));
    uv = clamp(uv, v_uvBounds.xy + halfTexel, v_uvBounds.zw - halfTexel);
  }
  o = texture(u_tex, uv) * (u_alpha * v_opacity);
}`;

export const GRID_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const GRID_FS = `#version 300 es
precision highp float;
uniform vec2 u_origin;
uniform float u_pixels;
uniform float u_radius;
uniform vec4 u_color;
out vec4 o;
void main() {
  vec2 world = u_origin + gl_FragCoord.xy * vec2(1.0, -1.0) / u_pixels;
  vec2 offset = mod(world + 16.0, 32.0) - 16.0;
  float distance = length(offset * u_pixels);
  o = u_color * (1.0 - smoothstep(max(0.0, u_radius - 0.5), u_radius + 0.5, distance));
}`;

// Soft shadows under rounded rectangles. Same instance layout as RECT_VS: box (already offset by dy),
// misc (radius, Gaussian standard deviation, both world units) and premultiplied colour in the fill slot.
// The mask is the rounded box convolved with a Gaussian: exact (erf) across x, four samples down y.
export const SHADOW_VS = `#version 300 es
precision highp float;
uniform vec2 u_view;
uniform float u_zoom;
${PLACE}
layout(location=0) in vec4 a_box;
layout(location=1) in vec2 a_misc;
layout(location=2) in vec4 a_color;
out vec2 v_p;
flat out vec2 v_half;
flat out vec2 v_rs;
flat out vec4 v_color;
void main() {
  ${PLACE_SKIP}
  vec2 q = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 half_ = a_box.zw * 0.5 * u_zoom;
  vec2 c = (box_xy + a_box.zw * 0.5) * u_zoom;
  float sigma = max(a_misc.y * u_zoom, 0.5);
  vec2 l = (q * 2.0 - 1.0) * (half_ + vec2(3.0 * sigma + 1.0));
  vec2 corner = c + l;
  gl_Position = vec4(corner.x / (u_view.x * 0.5), -corner.y / (u_view.y * 0.5), 0.0, 1.0);
  v_p = l;
  v_half = half_;
  v_rs = vec2(min(a_misc.x * u_zoom, min(half_.x, half_.y)), sigma);
  v_color = a_color;
}`;

export const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec2 v_half;
flat in vec2 v_rs;
flat in vec4 v_color;
out vec4 o;
vec2 erf2(vec2 x) {
  vec2 s = sign(x), a = abs(x);
  x = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  x *= x;
  return s - s / (x * x);
}
// Coverage across x of the blurred box at a height y from its centre; rounded corners narrow the span.
float spanX(float x, float y, float sigma, float r, vec2 h) {
  float delta = min(h.y - r - abs(y), 0.0);
  float reach = h.x - r + sqrt(max(0.0, r * r - delta * delta));
  vec2 i = 0.5 + 0.5 * erf2((x + vec2(-reach, reach)) * (0.70710678 / sigma));
  return i.y - i.x;
}
void main() {
  float sigma = v_rs.y;
  float lo = v_p.y - v_half.y, hi = v_p.y + v_half.y;
  float start = clamp(-3.0 * sigma, lo, hi);
  float stop = clamp(3.0 * sigma, lo, hi);
  float step_ = (stop - start) * 0.25;
  float y = start + step_ * 0.5;
  float v = 0.0;
  for (int i = 0; i < 4; i++) {
    v += spanX(v_p.x, v_p.y - y, sigma, v_rs.x, v_half) * exp(-(y * y) / (2.0 * sigma * sigma)) * step_;
    y += step_;
  }
  o = v_color * clamp(v / (2.50662827 * sigma), 0.0, 1.0);
}`;

// Canvas surface: one full-screen pass over the cleared background. Gradient and vignette are fixed to the
// screen; dots are fixed to the world (u_origin is the world point of the bottom-left pixel, modulo spacing).
// Every colour is premultiplied; an alpha of 0 switches that layer off.
export const SURFACE_FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform vec4 u_top;
uniform vec4 u_bottom;
uniform float u_vignette;
uniform vec4 u_dot;
uniform vec2 u_origin;
uniform float u_pixels;
uniform float u_spacing;
uniform float u_radius;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec4 c = mix(u_bottom, u_top, uv.y);
  if (c.a > 0.0) {
    // Ordered noise of under one 8-bit step hides banding in long, shallow gradients.
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    c.rgb = clamp(c.rgb + (n - 0.5) / 255.0 * c.a, 0.0, 1.0);
  }
  if (u_dot.a > 0.0) {
    vec2 world = u_origin + gl_FragCoord.xy * vec2(1.0, -1.0) / u_pixels;
    vec2 offset = mod(world + 0.5 * u_spacing, u_spacing) - 0.5 * u_spacing;
    float d = length(offset * u_pixels);
    vec4 dot_ = u_dot * (1.0 - smoothstep(max(0.0, u_radius - 0.5), u_radius + 0.5, d));
    c = dot_ + c * (1.0 - dot_.a);
  }
  if (u_vignette > 0.0) {
    // Elliptical, as an SVG radial gradient at 75% of the box: clear to 55%, full strength at the rim.
    float a = u_vignette * clamp((length((uv - 0.5) / 0.75) - 0.55) / 0.45, 0.0, 1.0);
    c = vec4(0.0, 0.0, 0.0, a) + c * (1.0 - a);
  }
  o = c;
}`;
