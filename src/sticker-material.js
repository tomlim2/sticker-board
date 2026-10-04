import * as THREE from 'three';

// 스티커 한 장 = 잘게 나눈 평면. 벗길 때는 정점 셰이더가 접히는 선 너머를 원기둥에 감아 올림 (책장 넘김 곡선).
//
//   d < 0          바닥에 붙은 부분
//   0 ≤ d < πR     반지름 R 원기둥을 따라 말려 올라가는 부분
//   d ≥ πR         뒤집혀서 2R 높이에 평평하게 얹힌 부분 (뒷면이 보임)
//
// 깊이 버퍼 없이 겹친 순서를 맞추려고 같은 스티커를 영역별로 4번 그림 (uPass 0~3, 아래쪽부터).

const vertexShader = /* glsl */ `
  uniform vec2 uFoldPoint;   // 접히기 시작하는 선 위의 한 점 (스티커 로컬, y 위쪽)
  uniform vec2 uFoldNormal;  // 선에 수직, 벗겨지는 쪽을 향함
  uniform float uRadius;     // 말림 반지름
  uniform float uPeel;       // 1 이면 벗기는 중

  varying vec2 vUv;
  varying float vTheta;      // 원기둥을 따라 감긴 각도 (0 = 바닥, π = 완전히 뒤집힘)
  varying float vD;          // 접히는 선에서 떨어진 거리 (접기 전 기준)

  const float PI = 3.141592653589793;

  void main() {
    vUv = uv;
    vec3 p = position;
    vTheta = 0.0;
    vD = dot(p.xy - uFoldPoint, uFoldNormal);
    if (uPeel > 0.5 && vD > 0.0) {
      float r = max(uRadius, 0.001);
      vec2 base = p.xy - vD * uFoldNormal;
      if (vD < PI * r) {
        float t = vD / r;
        p.xy = base + uFoldNormal * (r * sin(t));
        p.z = r * (1.0 - cos(t));
        vTheta = t;
      } else {
        p.xy = base - uFoldNormal * (vD - PI * r);
        p.z = 2.0 * r;
        vTheta = PI;
      }
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;    // 미리 곱한 알파 (premultiplied)
  uniform float uPass;
  uniform float uPeel;
  uniform vec2 uFoldNormal;
  uniform float uRadius;
  uniform float uSheen;
  uniform float uOpacity;
  uniform vec3 uBack;        // 스티커 뒷면(접착면) 색

  varying vec2 vUv;
  varying float vTheta;
  varying float vD;

  const float PI = 3.141592653589793;
  const vec3 LIGHT = vec3(-0.30, 0.45, 0.84);

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    if (tex.a < 0.004) discard;

    // 이 패스가 맡은 영역만 그림: 0 바닥, 1 말림 아래쪽 반, 2 말림 위쪽 반, 3 뒤집혀 얹힌 부분
    float region = 0.0;
    if (uPeel > 0.5 && vD > 0.0) region = vTheta < PI * 0.5 ? 1.0 : (vTheta < PI - 0.01 ? 2.0 : 3.0);
    if (abs(region - uPass) > 0.5) discard;

    // 말린 면의 법선으로 명암
    vec3 normal = vec3(-sin(vTheta) * uFoldNormal, cos(vTheta));
    if (!gl_FrontFacing) normal = -normal;
    vec3 light = normalize(LIGHT);
    float diffuse = max(dot(normal, light), 0.0);
    float shade = (0.62 + 0.38 * diffuse) / (0.62 + 0.38 * light.z);
    float spec = pow(max(dot(normal, normalize(light + vec3(0.0, 0.0, 1.0))), 0.0), 36.0) * smoothstep(0.05, 0.6, vTheta);

    // 말려 올라간 곳 바로 앞 바닥에 지는 접촉 그림자
    if (uPeel > 0.5 && vD <= 0.0) shade *= 1.0 - 0.3 * exp(vD / max(uRadius * 1.6, 3.0));

    vec3 color;
    if (gl_FrontFacing) {
      // 비닐 광택: 대각선으로 옅게 지나가는 빛
      float band = exp(-pow(vUv.x - vUv.y * 0.6 - 0.15, 2.0) * 9.0);
      color = tex.rgb * shade + vec3(uSheen * band + spec * 0.55) * tex.a;
    } else {
      color = uBack * tex.a * shade + vec3(spec * 0.25) * tex.a;
    }
    gl_FragColor = vec4(color, tex.a) * uOpacity;
  }
`;

/** 한 스티커의 4개 패스가 같이 쓰는 uniform */
export function createStickerUniforms(texture) {
  return {
    uMap: { value: texture },
    uPeel: { value: 0 },
    uFoldPoint: { value: new THREE.Vector2() },
    uFoldNormal: { value: new THREE.Vector2(1, 0) },
    uRadius: { value: 1 },
    uSheen: { value: 0.05 },
    uOpacity: { value: 1 },
    // 셰이더가 sRGB 값 그대로 계산하니 Color(선형 변환됨) 대신 Vector3
    uBack: { value: new THREE.Vector3(0.91, 0.9, 0.87) },
  };
}

// 그림자: 칼선 모양을 흐린 텍스처. 벗겨져 들린 부분 아래엔 그림자가 남지 않게 접히는 선 너머는 지움
const shadowVertexShader = /* glsl */ `
  uniform vec2 uFoldPoint;
  uniform vec2 uFoldNormal;
  varying vec2 vUv;
  varying float vD;

  void main() {
    vUv = uv;
    vD = dot(position.xy - uFoldPoint, uFoldNormal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const shadowFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uPeel;
  uniform float uRadius;
  uniform float uStrength;
  varying vec2 vUv;
  varying float vD;

  void main() {
    float a = texture2D(uMap, vUv).a * uStrength;
    // 접히는 선 근처엔 말린 부분이 드리운 옅은 그림자만
    if (uPeel > 0.5) a *= 1.0 - 0.85 * smoothstep(-uRadius, uRadius * 3.0, vD);
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }
`;

export function createShadowMaterial(uniforms, texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uStrength: { value: 0.26 },
      uPeel: uniforms.uPeel,
      uFoldPoint: uniforms.uFoldPoint,
      uFoldNormal: uniforms.uFoldNormal,
      uRadius: uniforms.uRadius,
    },
    vertexShader: shadowVertexShader,
    fragmentShader: shadowFragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

export function createStickerMaterial(uniforms, pass) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPass: { value: pass } },
    vertexShader,
    fragmentShader,
    transparent: true,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
