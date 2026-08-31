/**
 * Grainient: a full-viewport animated gradient with film grain, rendered on a
 * WebGL quad via ogl. Pauses automatically when scrolled offscreen or when the
 * tab is hidden. Unmounts cleanly; the landing page is its only consumer.
 */

import { useEffect, useRef } from "react";
import { Renderer, Program, Mesh, Triangle, Vec2, Vec3 } from "ogl";
import "./Grainient.css";

export type GrainientProps = {
  /** Gradient colors as hex strings (without alpha). */
  readonly colors?: readonly [string, string, string];
  /** Animation speed multiplier; 1 is the default drift. */
  readonly speed?: number;
  /** Grain intensity, 0–1. */
  readonly grain?: number;
  readonly className?: string;
};

const VERTEX = /* glsl */ `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform vec2 uResolution;
uniform float uGrain;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;

// Cheap value noise for organic blob movement.
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  float t = uTime;
  float n1 = noise(p * 1.4 + vec2(t * 0.06, -t * 0.045));
  float n2 = noise(p * 2.1 - vec2(t * 0.05, t * 0.07));
  float blend = smoothstep(0.15, 0.95, n1 * 0.65 + n2 * 0.35);

  vec3 color = mix(uColorA, uColorB, blend);
  color = mix(color, uColorC, smoothstep(0.55, 1.0, n2) * 0.45);

  // Subtle vignette so edges fall back toward the base color.
  float vig = smoothstep(1.25, 0.35, distance(uv, vec2(0.5, 0.45)));
  color *= mix(0.92, 1.0, vig);

  // Film grain: per-pixel hash, signed so mid-gray is unaffected.
  float g = fract(sin(dot(uv * uResolution + t, vec2(12.9898, 78.233))) * 43758.5453);
  color += (g - 0.5) * uGrain;

  gl_FragColor = vec4(color, 1.0);
}
`;

function hexToRgb(hex: string): Vec3 {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return new Vec3(
    Number.parseInt(full.slice(0, 2), 16) / 255,
    Number.parseInt(full.slice(2, 4), 16) / 255,
    Number.parseInt(full.slice(4, 6), 16) / 255,
  );
}

const DEFAULT_COLORS: readonly [string, string, string] = ["#172112", "#233a1c", "#3ce767"];

export function Grainient({
  colors = DEFAULT_COLORS,
  speed = 1,
  grain = 0.055,
  className,
}: GrainientProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    let renderer: Renderer;
    try {
      renderer = new Renderer({
        alpha: false,
        antialias: false,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      });
    } catch {
      // No WebGL: leave the container transparent so the page background shows.
      return;
    }
    const gl = renderer.gl;
    gl.clearColor(0x17 / 255, 0x21 / 255, 0x12 / 255, 1);
    container.appendChild(gl.canvas);

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: VERTEX,
      fragment: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new Vec2(gl.canvas.width, gl.canvas.height) },
        uGrain: { value: grain },
        uColorA: { value: hexToRgb(colors[0] ?? "#172112") },
        uColorB: { value: hexToRgb(colors[1] ?? "#233a1c") },
        uColorC: { value: hexToRgb(colors[2] ?? "#3ce767") },
      },
    });
    const mesh = new Mesh(gl, { geometry, program });
    let raf = 0;
    let running = false;
    let visible = true;
    const start = performance.now();
    const element = container;

    function frame(): void {
      if (!running) {
        return;
      }
      program.uniforms["uTime"].value = ((performance.now() - start) / 1000) * speed;
      renderer.render({ scene: mesh });
      raf = requestAnimationFrame(frame);
    }

    function setRunning(next: boolean): void {
      const shouldRun = next && visible;
      if (shouldRun === running) {
        return;
      }
      running = shouldRun;
      if (running) {
        raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
      }
    }

    function resize(): void {
      renderer.setSize(element.clientWidth, element.clientHeight);
      (program.uniforms["uResolution"].value as Vec2).set(gl.canvas.width, gl.canvas.height);
    }

    const observer = new IntersectionObserver((entries) => {
      visible = entries.every((entry) => entry.isIntersecting);
      setRunning(true);
    });
    observer.observe(container);

    function onVisibility(): void {
      setRunning(document.visibilityState === "visible");
    }
    document.addEventListener("visibilitychange", onVisibility);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    setRunning(true);

    return () => {
      setRunning(false);
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      gl.canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [colors, speed, grain]);

  return (
    <div
      ref={containerRef}
      className={className === undefined ? "grainient" : `grainient ${className}`}
      aria-hidden
    />
  );
}
