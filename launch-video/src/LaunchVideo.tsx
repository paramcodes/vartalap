import React from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

// Expo curves: expo out for arrivals, expo in for departures
function expoOut(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function expoIn(t: number): number {
  return t <= 0 ? 0 : Math.pow(2, 10 * (t - 1));
}

interface MaskedWordProps {
  word: string;
  index: number;
  startFrame: number;
  durationFrames?: number;
  exitFrame: number;
}

const MaskedWord: React.FC<MaskedWordProps> = ({
  word,
  index,
  startFrame,
  durationFrames = 18,
  exitFrame,
}) => {
  const frame = useCurrentFrame();
  const wordStart = startFrame + index * 5;

  // Arrival animation
  const enterT = Math.min(1, Math.max(0, (frame - wordStart) / durationFrames));
  const enterVal = expoOut(enterT);

  // Departure animation
  const exitT = Math.min(1, Math.max(0, (frame - exitFrame) / 14));
  const exitVal = expoIn(exitT);

  const translateY = (1 - enterVal) * 115 + exitVal * -120;
  const opacity = enterT > 0 ? (1 - exitVal) : 0;

  return (
    <span
      style={{
        display: 'inline-block',
        overflow: 'hidden',
        marginRight: '0.32em',
        verticalAlign: 'bottom',
        paddingBottom: '0.08em',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          transform: `translateY(${translateY}%)`,
          opacity,
          letterSpacing: '-0.03em',
        }}
      >
        {word}
      </span>
    </span>
  );
};

interface CaptionProps {
  text: string;
  startFrame: number;
  endFrame: number;
  position?: 'top' | 'bottom';
  accent?: string;
}

const KineticCaption: React.FC<CaptionProps> = ({
  text,
  startFrame,
  endFrame,
  position = 'top',
  accent = '#38bdf8',
}) => {
  const frame = useCurrentFrame();
  if (frame < startFrame || frame > endFrame) return null;

  const words = text.split(' ');
  const exitStart = endFrame - 15;

  return (
    <div
      style={{
        position: 'absolute',
        left: '80px',
        right: '80px',
        ...(position === 'top' ? { top: '70px' } : { bottom: '80px' }),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'rgba(15, 23, 42, 0.88)',
          backdropFilter: 'blur(16px)',
          border: '1.5px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '24px',
          padding: '16px 36px',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.45)',
        }}
      >
        <span
          style={{
            fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
            fontSize: '52px',
            fontWeight: 800,
            color: '#ffffff',
            textTransform: 'uppercase',
            lineHeight: 1.1,
          }}
        >
          {words.map((w, idx) => (
            <span key={idx} style={{ color: idx === words.length - 1 ? accent : '#ffffff' }}>
              <MaskedWord
                word={w}
                index={idx}
                startFrame={startFrame + 4}
                exitFrame={exitStart}
              />
            </span>
          ))}
        </span>
      </div>
    </div>
  );
};

export const LaunchVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Beats definition (60fps):
  // Beat 1: frames 0..270 (0.0s - 4.5s) -> Direct Chat Init
  // Beat 2: frames 270..540 (4.5s - 9.0s) -> Optimistic Local Writes
  // Beat 3: frames 540..810 (9.0s - 13.5s) -> Strict Monotonic Sequencing
  // Beat 4: frames 810..1050 (13.5s - 17.5s) -> Derived Watermarks (Seen)
  // Beat 5: frames 1050..1260 (17.5s - 21.0s) -> Adaptive Tokens & Dark Mode
  // Outro:  frames 1260..1440 (21.0s - 24.0s) -> Logo Draw-in & Facts

  // Camera Punch Transforms
  let scale = 1.0;
  let originX = 50;
  let originY = 50;

  if (frame < 270) {
    // Beat 1: Direct Chat Card
    const t = Math.min(1, frame / 35);
    scale = 1.1 + 0.25 * expoOut(t);
    originX = 50;
    originY = 52;
  } else if (frame < 540) {
    // Beat 2: Composer Textarea & Send Button
    const t = Math.min(1, (frame - 270) / 30);
    scale = 1.25 + 0.35 * expoOut(t);
    originX = 50;
    originY = 96;
  } else if (frame < 810) {
    // Beat 3: Message Bubbles & Fused Burst Corners
    const t = Math.min(1, (frame - 540) / 30);
    scale = 1.35 + 0.35 * expoOut(t);
    originX = 56;
    originY = 12;
  } else if (frame < 1050) {
    // Beat 4: Close-up punch on Watermark
    const t = Math.min(1, (frame - 810) / 30);
    scale = 1.45 + 0.55 * expoOut(t);
    originX = 61;
    originY = 15;
  } else if (frame < 1260) {
    // Beat 5: Full Dark Mode & Focus Mode Layout
    const t = Math.min(1, (frame - 1050) / 30);
    scale = 1.25 - 0.2 * expoOut(t);
    originX = 50;
    originY = 50;
  }

  // Outro Animation (frames 1260..1440)
  const isOutro = frame >= 1260;
  const outroFrame = Math.max(0, frame - 1260);
  const outroT = Math.min(1, outroFrame / 35);
  const outroEase = expoOut(outroT);

  // Logo draw-in: strokeDashoffset from 320 to 0
  const pathLength = 320;
  const strokeOffset = Math.max(0, pathLength * (1 - expoOut(Math.min(1, outroFrame / 45))));

  return (
    <AbsoluteFill style={{ backgroundColor: '#090d16', overflow: 'hidden' }}>
      {/* Background Audio */}
      <Audio src={staticFile('soundtrack.wav')} />

      {/* Real Application Footage with Camera Punch per Beat */}
      {/* Beat 1: 0 to 4.5s (0..270) -> Starting Conversation */}
      <Sequence from={0} durationInFrames={270}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile('footage.mp4')}
            startFrom={Math.floor(18.0 * 60)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Beat 2: 4.5 to 9.0s (270..540) -> Optimistic Local Writes */}
      <Sequence from={270} durationInFrames={270}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile('footage.mp4')}
            startFrom={Math.floor(26.0 * 60)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Beat 3: 9.0 to 13.5s (540..810) -> Strict Monotonic Sequencing & Burst Corners */}
      <Sequence from={540} durationInFrames={270}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile('footage.mp4')}
            startFrom={Math.floor(33.0 * 60)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Beat 4: 13.5 to 17.5s (810..1050) -> Derived "Seen" Watermarks */}
      <Sequence from={810} durationInFrames={240}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile('footage.mp4')}
            startFrom={Math.floor(36.0 * 60)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Beat 5: 17.5 to 21.0s (1050..1260) -> Dark Mode & Collapsible Focus Mode */}
      <Sequence from={1050} durationInFrames={210}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        >
          <OffthreadVideo
            src={staticFile('footage.mp4')}
            startFrom={Math.floor(44.0 * 60)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      </Sequence>

      {/* Kinetic Captions for Each Beat */}
      <KineticCaption
        text="MESSAGING BUILT TO LAST"
        startFrame={10}
        endFrame={260}
        position="top"
        accent="#38bdf8"
      />
      <KineticCaption
        text="OPTIMISTIC LOCAL WRITES"
        startFrame={280}
        endFrame={530}
        position="top"
        accent="#34d399"
      />
      <KineticCaption
        text="STRICT MONOTONIC SEQUENCING"
        startFrame={550}
        endFrame={800}
        position="bottom"
        accent="#60a5fa"
      />
      <KineticCaption
        text="ZERO RESIDUAL PRIVACY LEAKS"
        startFrame={820}
        endFrame={1040}
        position="bottom"
        accent="#a78bfa"
      />
      <KineticCaption
        text="ADAPTIVE MESSENGER TOKENS"
        startFrame={1060}
        endFrame={1245}
        position="bottom"
        accent="#f472b6"
      />

      {/* Outro Card */}
      {isOutro && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(9, 13, 22, ${0.94 * outroEase})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            opacity: outroEase,
          }}
        >
          {/* Animated Logo Drawing */}
          <div style={{ marginBottom: '24px' }}>
            <svg width="110" height="110" viewBox="0 0 100 100" fill="none">
              <rect
                x="6"
                y="6"
                width="88"
                height="88"
                rx="24"
                stroke="#0ea5e9"
                strokeWidth="5"
                strokeDasharray={pathLength}
                strokeDashoffset={strokeOffset}
                fill="rgba(14, 165, 233, 0.12)"
              />
              <path
                d="M32 30L50 72L68 30"
                stroke="#ffffff"
                strokeWidth="7"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="160"
                strokeDashoffset={Math.max(0, 160 * (1 - expoOut(Math.min(1, Math.max(0, outroFrame - 10) / 40))))}
              />
            </svg>
          </div>

          <h1
            style={{
              fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
              fontSize: '68px',
              fontWeight: 800,
              color: '#ffffff',
              letterSpacing: '-0.04em',
              margin: '0 0 8px 0',
            }}
          >
            vartalap
          </h1>

          <p
            style={{
              fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
              fontSize: '24px',
              fontWeight: 500,
              color: '#94a3b8',
              margin: '0 0 36px 0',
            }}
          >
            A resilient, durable real-time messenger
          </p>

          {/* 3 Facts Badges */}
          <div style={{ display: 'flex', gap: '16px', marginBottom: '40px' }}>
            {[
              'Zero Inverted Ordering',
              'Offline-First Dexie Storage',
              'Gate 1 Security Hardened',
            ].map((fact, idx) => {
              const badgeDelay = 15 + idx * 8;
              const badgeT = Math.min(1, Math.max(0, (outroFrame - badgeDelay) / 25));
              const badgeEase = expoOut(badgeT);
              return (
                <div
                  key={idx}
                  style={{
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1.5px solid rgba(255, 255, 255, 0.14)',
                    padding: '12px 24px',
                    borderRadius: '16px',
                    color: '#e2e8f0',
                    fontFamily: 'Inter, system-ui, sans-serif',
                    fontSize: '17px',
                    fontWeight: 600,
                    opacity: badgeEase,
                    transform: `translateY(${(1 - badgeEase) * 20}px)`,
                  }}
                >
                  <span style={{ color: '#38bdf8', marginRight: '8px' }}>✓</span>
                  {fact}
                </div>
              );
            })}
          </div>

          {/* Domain / CTA */}
          <div
            style={{
              fontFamily: 'Inter, system-ui, monospace',
              fontSize: '22px',
              color: '#38bdf8',
              background: 'rgba(56, 189, 248, 0.1)',
              padding: '10px 28px',
              borderRadius: '999px',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              letterSpacing: '0.04em',
            }}
          >
            github.com/paramcodes/vartalap
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
