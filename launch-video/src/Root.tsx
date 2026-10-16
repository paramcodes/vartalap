import React from 'react';
import { Composition } from 'remotion';
import { LaunchVideo } from './LaunchVideo.tsx';

export const Root: React.FC = () => {
  return (
    <Composition
      id="LaunchVideo"
      component={LaunchVideo}
      durationInFrames={1440}
      fps={60}
      width={1920}
      height={1080}
    />
  );
};
