// Flames, smoke and embers. All are instanced billboards driven by the shared fire clock: an
// emitter wakes when the clock passes its ignition time, burns for a while, then only smokes.
// Flames are procedural (scrolling noise shaped into a tongue, coloured by temperature) with additive
// light; smoke is soft puffs that rise, grow, lean with the wind and thin out.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  NormalBlending, PlaneGeometry, Points, ShaderMaterial, Vector3,
} from "three";
import { FOREST_HALF, groundY, igniteTime, riverX, rng, WORLD_GLSL } from "./common";
import type { Forest, TreeSite } from "./forest";
import { Z_FAR, Z_NEAR } from "./forest";
import { puffTexture } from "./textures";

export interface Fire {
  group: Group;
  uniforms: { uEmbers: { value: number }; uCam: { value: Vector3 }; uWindDir: { value: Vector3 } };
}

const FOG = /* glsl */ `
  uniform vec3 fogColor; uniform float fogDensity;
  float fogF(float d) { return 1.0 - exp(-fogDensity * fogDensity * d * d); }
`;

/** A unit quad instanced `count` times, with one instanced attribute per entry of `attrs`. */
export function quadGeometry(attrs: Record<string, [Float32Array, number]>, count: number): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  const g = new InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute("position", quad.attributes.position);
  g.setAttribute("uv", quad.attributes.uv);
  for (const [k, [arr, size]] of Object.entries(attrs)) g.setAttribute(k, new InstancedBufferAttribute(arr, size));
  g.instanceCount = count;
  return g;
}

export function buildFire(forest: Forest, small: boolean): Fire {
  const group = new Group();
  const R = rng(99);
  const fu = forest.uniforms;
  const uniforms: Fire["uniforms"] = { uEmbers: { value: 0 }, uCam: { value: new Vector3() }, uWindDir: { value: new Vector3(0.8, 0, 0.3) } };
  const inTreeZone = (x: number, z: number) => z < 300 && z > -2770 && Math.abs(x - riverX(z)) < FOREST_HALF - 20;

  // ---------------------------------------------------------------- flame emitters
  const fPos: number[] = [], fSize: number[] = [], fIgn: number[] = [], fSeed: number[] = [], fDur: number[] = [];
  const addFlame = (x: number, y: number, z: number, size: number, ign: number, dur: number) => {
    fPos.push(x, y, z); fSize.push(size); fIgn.push(ign); fSeed.push(R()); fDur.push(dur);
  };
  const perTree: Record<TreeSite["species"], number> = { emergent: 5, canopy: 3, palm: 2, shrub: 1 };
  for (const t of forest.trees) {
    for (let i = 0; i < perTree[t.species]; i++) {
      const a = R() * Math.PI * 2, d = Math.sqrt(R()) * t.crownR * 0.7;
      addFlame(t.x + Math.cos(a) * d, t.crownY - 2 + R() * 3, t.z + Math.sin(a) * d, (t.species === "emergent" ? 14 : 9) * (0.7 + R() * 0.6), t.ignite + R() * 0.3, 1);
    }
    if (R() < 0.5) addFlame(t.x + (R() - 0.5) * 4, t.ground + 1, t.z + (R() - 0.5) * 4, 4 + R() * 3, t.ignite - 0.2, 1.8);   // ground fire
  }
  const S = small ? 85 : 58;
  for (let z = Z_NEAR - 200; z > Z_FAR + 200; z -= S) {
    for (let x = -4300; x < 4300; x += S) {
      const jx = x + (R() - 0.5) * S, jz = z + (R() - 0.5) * S;
      if (inTreeZone(jx, jz)) continue;
      const g = groundY(jx, jz) + 28 + R() * 10;
      addFlame(jx, g, jz, 26 + R() * 26, igniteTime(jx, jz) + (R() - 0.5) * 0.4, 1.2);
    }
  }
  const flames = new Mesh(quadGeometry({
    aPos: [new Float32Array(fPos), 3], aSize: [new Float32Array(fSize), 1], aIgnite: [new Float32Array(fIgn), 1],
    aSeed: [new Float32Array(fSeed), 1], aDur: [new Float32Array(fDur), 1],
  }, fSize.length), new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending, fog: true,
    uniforms: { uTime: fu.uTime, uFireClock: fu.uFireClock, fogColor: { value: new Color() }, fogDensity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uFireClock;
      attribute vec3 aPos; attribute float aSize, aIgnite, aSeed, aDur;
      varying vec2 vUv; varying float vEnv; varying float vDepth; varying float vSeed;
      void main() {
        float local = uFireClock - aIgnite;
        vEnv = smoothstep(0.0, 0.2, local) * (1.0 - smoothstep(0.9 * aDur, 1.5 * aDur, local));
        if (vEnv <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec4 mv = viewMatrix * vec4(aPos, 1.0);
        float s = aSize * (0.55 + 0.45 * vEnv) * (0.9 + 0.2 * sin(uTime * 3.0 + aSeed * 20.0));
        mv.xy += vec2(position.x * s * 0.9, (position.y + 0.42) * s * 1.5);
        vUv = uv; vSeed = aSeed; vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      ${WORLD_GLSL}
      ${FOG}
      varying vec2 vUv; varying float vEnv; varying float vDepth; varying float vSeed;
      void main() {
        vec2 uv = vUv;
        // Turbulence: the whole tongue is pushed sideways by rising noise, more towards the tip,
        // and tears into separate licks; a wide base, ragged sides, no solid core.
        float t = uTime * 1.7 + vSeed * 50.0;
        float warp = (fbm(vec2(uv.y * 2.2 - t * 0.9, vSeed * 7.0)) - 0.5) * 0.55 * uv.y;
        vec2 q = vec2(uv.x - 0.5 + warp, uv.y);
        float n = fbm(vec2(q.x * 4.0 + vSeed * 31.0, q.y * 3.0 - t * 1.6));
        float n2 = fbm(vec2(q.x * 9.0 - vSeed * 9.0, q.y * 6.5 - t * 2.6));
        float width = mix(0.46, 0.08, pow(q.y, 0.8));                 // broad at the base, narrow at the tip
        float side = 1.0 - smoothstep(width * 0.35, width, abs(q.x) + (n - 0.5) * 0.22);
        float rise = 1.0 - smoothstep(0.25, 0.95, q.y + (n2 - 0.5) * 0.35);
        float base = smoothstep(0.0, 0.08, q.y);
        float f = clamp(side * rise * base * (0.6 + 0.8 * n2), 0.0, 1.0);
        // temperature colour: deep red at the ragged edges, orange body, a yellow heart low down
        vec3 col = mix(vec3(0.45, 0.04, 0.0), vec3(1.0, 0.32, 0.03), smoothstep(0.08, 0.5, f));
        col = mix(col, vec3(1.0, 0.72, 0.28), smoothstep(0.62, 0.95, f) * (1.0 - smoothstep(0.2, 0.7, q.y)));
        // soft glow around the flame (light scattered in smoke)
        float halo = exp(-dot(vec2(uv.x - 0.5, (uv.y - 0.3) * 0.7), vec2(uv.x - 0.5, (uv.y - 0.3) * 0.7)) * 9.0) * 0.18;
        float a = (f + halo) * vEnv * smoothstep(2.0, 12.0, vDepth) * (1.0 - fogF(vDepth) * 0.8);
        gl_FragColor = vec4(mix(vec3(1.0, 0.35, 0.05), col, f / max(f + halo, 1e-3)) * a * 1.25, a);
      }`,
  }));
  flames.frustumCulled = false;
  flames.renderOrder = 4;
  group.add(flames);

  // ---------------------------------------------------------------- smoke
  const sPos: number[] = [], sIgn: number[] = [], sSeed: number[] = [], sScale: number[] = [], sRise: number[] = [], sSpeed: number[] = [];
  const addSmoke = (x: number, y: number, z: number, ign: number, scale: number, rise: number, puffs: number) => {
    for (let i = 0; i < puffs; i++) {
      sPos.push(x + (R() - 0.5) * scale * 0.3, y, z + (R() - 0.5) * scale * 0.3);
      sIgn.push(ign); sSeed.push(i / puffs + R() * 0.1); sScale.push(scale * (0.8 + R() * 0.4)); sRise.push(rise); sSpeed.push(0.05 + R() * 0.03);
    }
  };
  forest.trees.forEach((t, i) => { if (i % 3 === 0) addSmoke(t.x, t.crownY, t.z, t.ignite + 0.3, 20, 110, 3); });
  const S2 = small ? 230 : 165;
  for (let z = Z_NEAR - 200; z > Z_FAR + 200; z -= S2) {
    for (let x = -4300; x < 4300; x += S2) {
      const jx = x + (R() - 0.5) * S2, jz = z + (R() - 0.5) * S2;
      addSmoke(jx, groundY(jx, jz) + 35, jz, igniteTime(jx, jz) + 0.5, 120 + R() * 90, 800 + R() * 500, small ? 3 : 5);
    }
  }
  const smokeMat = new ShaderMaterial({
    transparent: true, depthWrite: false, blending: NormalBlending, fog: true,
    uniforms: { uTime: fu.uTime, uFireClock: fu.uFireClock, uMap: { value: puffTexture() }, uWindDir: uniforms.uWindDir,
      fogColor: { value: new Color() }, fogDensity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uFireClock; uniform vec3 uWindDir;
      attribute vec3 aPos; attribute float aIgnite, aSeed, aScale, aRise, aSpeed;
      varying vec2 vUv; varying float vA; varying float vAge; varying float vDepth;
      void main() {
        float local = uFireClock - aIgnite;
        float env = smoothstep(0.0, 0.8, local) * (1.0 - smoothstep(7.0, 16.0, local));
        if (env <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float age = fract(uTime * aSpeed + aSeed);
        vec3 p = aPos + vec3(0.0, age * aRise, 0.0) + uWindDir * age * age * aRise * 0.7;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float s = aScale * (0.45 + age * 2.2);
        float r = aSeed * 6.28 + uTime * 0.05;
        mv.xy += mat2(cos(r), -sin(r), sin(r), cos(r)) * position.xy * s;
        vDepth = -mv.z;
        vA = env * smoothstep(0.0, 0.12, age) * pow(1.0 - age, 1.3) * smoothstep(4.0, 40.0, vDepth);
        vAge = age; vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      ${FOG}
      varying vec2 vUv; varying float vA; varying float vAge; varying float vDepth;
      void main() {
        float t = texture2D(uMap, vUv).a;
        // dark and dense at the source, pale grey-brown and sunlit as it rises and thins
        vec3 col = mix(vec3(0.2, 0.18, 0.165), vec3(0.66, 0.6, 0.54), smoothstep(0.0, 0.55, vAge)) * (0.85 + 0.3 * vUv.y);
        col += vec3(0.5, 0.18, 0.03) * (1.0 - smoothstep(0.0, 0.25, vAge)) * (1.0 - vUv.y);   // lit by the fire below
        col = mix(col, fogColor, fogF(vDepth) * 0.8);
        gl_FragColor = vec4(col, t * vA * 0.95);
      }`,
  });
  const smoke = new Mesh(quadGeometry({
    aPos: [new Float32Array(sPos), 3], aIgnite: [new Float32Array(sIgn), 1], aSeed: [new Float32Array(sSeed), 1],
    aScale: [new Float32Array(sScale), 1], aRise: [new Float32Array(sRise), 1], aSpeed: [new Float32Array(sSpeed), 1],
  }, sScale.length), smokeMat);
  smoke.frustumCulled = false;
  smoke.renderOrder = 3;
  group.add(smoke);

  // ---------------------------------------------------------------- embers around the camera
  const eCount = small ? 600 : 1300;
  const eb = new Float32Array(eCount * 3), es = new Float32Array(eCount);
  for (let i = 0; i < eCount; i++) { eb.set([(R() - 0.5) * 160, R() * 90, (R() - 0.5) * 160], i * 3); es[i] = R(); }
  const eGeo = new BufferGeometry();
  eGeo.setAttribute("position", new BufferAttribute(eb, 3));
  eGeo.setAttribute("aSeed", new BufferAttribute(es, 1));
  const embers = new Points(eGeo, new ShaderMaterial({
    transparent: true, depthWrite: false, blending: AdditiveBlending,
    uniforms: { uTime: fu.uTime, uCam: uniforms.uCam, uAmt: uniforms.uEmbers, uScale: { value: window.innerHeight * 0.5 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uAmt, uScale; uniform vec3 uCam; attribute float aSeed; varying float vA;
      void main() {
        vec3 p = position;
        p.xz = mod(p.xz - uCam.xz + 80.0, 160.0) - 80.0 + uCam.xz;
        p.y = uCam.y - 40.0 + mod(p.y + uTime * (3.0 + aSeed * 7.0), 90.0);
        p.x += sin(uTime * 1.3 + aSeed * 40.0) * 2.0;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vA = (0.4 + 0.6 * sin(uTime * 9.0 + aSeed * 60.0)) * step(aSeed, uAmt);
        gl_PointSize = (0.35 + aSeed * 0.9) * uScale / max(-mv.z, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA;
        gl_FragColor = vec4(vec3(1.0, 0.6, 0.22) * a, a);
      }`,
  }));
  embers.frustumCulled = false;
  embers.renderOrder = 5;
  group.add(embers);

  return { group, uniforms };
}
