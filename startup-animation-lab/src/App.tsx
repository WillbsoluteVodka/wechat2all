import { useEffect, useRef } from "react";
import * as THREE from "three";

type ShaderScene = {
  camera: THREE.Camera;
  geometry: THREE.PlaneGeometry;
  material: THREE.ShaderMaterial;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  animationId: number;
};

function ShaderAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ShaderScene | null>(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const container = containerRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const vertexShader = `
      void main() {
        gl_Position = vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      #define TWO_PI 6.2831853072
      #define PI 3.14159265359

      precision highp float;
      uniform vec2 resolution;
      uniform float time;

      void main(void) {
        vec2 uv = (gl_FragCoord.xy * 2.0 - resolution.xy) / min(resolution.x, resolution.y);
        float t = time * 0.05;
        float lineWidth = 0.002;

        vec3 energy = vec3(0.0);
        for (int j = 0; j < 3; j++) {
          for (int i = 0; i < 5; i++) {
            energy[j] += lineWidth * float(i * i) / abs(
              fract(t - 0.01 * float(j) + float(i) * 0.01) * 5.0
              - length(uv)
              + mod(uv.x + uv.y, 0.2)
            );
          }
        }

        float glow = max(max(energy.r, energy.g), energy.b);
        float edge = smoothstep(0.025, 0.55, glow);
        float hotEdge = smoothstep(0.68, 2.05, glow);
        float intensity = smoothstep(0.0, 0.78, glow);
        float metalBand = smoothstep(0.02, 0.34, energy.r + energy.b);
        vec3 channels = 1.0 - exp(-energy * vec3(0.95, 1.45, 1.08));
        vec3 channelEdges = smoothstep(vec3(0.008), vec3(0.58), energy);
        vec3 softChannels = smoothstep(vec3(0.002), vec3(0.28), energy);

        vec3 black = vec3(0.0);
        vec3 graphite = vec3(0.035, 0.039, 0.038);
        vec3 brushedSilver = vec3(0.52, 0.54, 0.53);
        vec3 chromeWhite = vec3(0.88, 0.89, 0.86);
        vec3 metallicGreen = vec3(0.1098, 0.8314, 0.3373);
        vec3 coldSilver = vec3(0.73, 0.86, 0.78);
        vec3 paleGreenWhite = vec3(0.82, 1.0, 0.88);

        vec3 metal = graphite * edge * 0.18;
        metal += brushedSilver * channelEdges.r * 0.82;
        metal += metallicGreen * channelEdges.g * 0.96;
        metal += coldSilver * channelEdges.b * 0.74;
        metal += paleGreenWhite * channelEdges.b * channelEdges.g * 0.46;
        metal += vec3(0.045, 0.09, 0.055) * metalBand;
        vec3 softHaze = brushedSilver * softChannels.r * 0.16;
        softHaze += metallicGreen * softChannels.g * 0.17;
        softHaze += coldSilver * softChannels.b * 0.14;
        softHaze *= 1.0 - hotEdge * 0.38;

        float greenHint = smoothstep(0.18, 1.35, energy.g)
          * smoothstep(0.25, 1.3, glow)
          * (0.11 + hotEdge * 0.08);
        float whiteCore = smoothstep(0.55, 1.65, channels.r + channels.g + channels.b);
        vec3 finalColor = vec3(0.004, 0.014, 0.008);
        finalColor += metal * (0.12 + intensity * 0.68);
        finalColor += softHaze;
        finalColor += metallicGreen * greenHint;
        finalColor = mix(finalColor, chromeWhite, whiteCore * 0.14 + hotEdge * 0.08);
        finalColor *= 0.7 + hotEdge * 0.1;
        finalColor = clamp(finalColor, black, vec3(1.0));

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `;

    const camera = new THREE.Camera();
    camera.position.z = 1;

    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const uniforms = {
      time: { value: 1.0 },
      resolution: { value: new THREE.Vector2() },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    renderer.setClearColor(0x000000, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    function resize() {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      uniforms.resolution.value.set(
        renderer.domElement.width,
        renderer.domElement.height,
      );
    }

    function renderFrame() {
      renderer.render(scene, camera);
    }

    function clamp01(value: number) {
      return Math.min(1, Math.max(0, value));
    }

    function smoothstep(edge0: number, edge1: number, value: number) {
      const x = clamp01((value - edge0) / (edge1 - edge0));
      return x * x * (3 - 2 * x);
    }

    function setStartupTextMotion() {
      const phase = ((uniforms.time.value * 0.05) % 1 + 1) % 1;
      const fadeIn = smoothstep(0.51, 0.63, phase);
      const fadeOut = 1 - smoothstep(0.8, 0.88, phase);
      const opacity = clamp01(fadeIn * fadeOut * 1.08);
      const rootStyle = document.documentElement.style;

      rootStyle.setProperty("--startup-copy-opacity", opacity.toFixed(3));
      rootStyle.setProperty(
        "--startup-copy-blur",
        `${((1 - opacity) * 12).toFixed(2)}px`,
      );
    }

    const startedAt = performance.now();
    const shaderSecondsPerSecond = 1.5;

    function scheduleFrame(callback: (now: number) => void) {
      if (typeof window.requestAnimationFrame === "function") {
        return window.requestAnimationFrame(callback);
      }

      return window.setTimeout(() => {
        callback(performance.now());
      }, 1000 / 60);
    }

    function cancelScheduledFrame(animationId: number) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(animationId);
        return;
      }

      window.clearTimeout(animationId);
    }

    function animate(now = performance.now()) {
      const animationId = scheduleFrame(animate);
      uniforms.time.value =
        1.0 + ((now - startedAt) / 1000) * shaderSecondsPerSecond;
      setStartupTextMotion();
      renderFrame();

      if (sceneRef.current) {
        sceneRef.current.animationId = animationId;
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    window.addEventListener("resize", resize);

    sceneRef.current = {
      animationId: 0,
      camera,
      geometry,
      material,
      renderer,
      scene,
    };

    resize();
    setStartupTextMotion();
    renderFrame();

    if (!reduceMotion.matches) {
      animate();
    }

    return () => {
      window.removeEventListener("resize", resize);
      resizeObserver.disconnect();

      if (sceneRef.current) {
        cancelScheduledFrame(sceneRef.current.animationId);
      }

      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }

      renderer.dispose();
      geometry.dispose();
      material.dispose();
      scene.clear();
      sceneRef.current = null;

      [
        "--startup-copy-opacity",
        "--startup-copy-blur",
      ].forEach((property) => {
        document.documentElement.style.removeProperty(property);
      });
    };
  }, []);

  return <div ref={containerRef} className="shader-animation" />;
}

export default function App() {
  return (
    <main className="lab-shell" aria-label="Shader animation lab">
      <ShaderAnimation />
      <section className="startup-copy" aria-label="Shader Animation startup">
        <h1 className="startup-title">Shader Animation</h1>
      </section>
    </main>
  );
}
