import React, { useRef, useEffect, useState, useContext } from 'react';
import { View, StyleSheet, Animated, AppState, type AppStateStatus } from 'react-native';
import { NavigationContext } from '@react-navigation/native';
import Svg, { Path, Defs, LinearGradient, Stop, ClipPath, Rect, G } from 'react-native-svg';
import { useTheme } from '../contexts/ThemeContext';
import type { WaveStop } from '../styles/theme';

interface WaveBackgroundProps {
  /** Disambiguates SVG gradient/clip ids when several instances are mounted. */
  prefix?: string;
  /** Drop to 1 for the single-wave still variant used by the history drawer. */
  waves?: 1 | 4;
  /** When false the waves render un-animated, at rest position. */
  animated?: boolean;
}

const WAVE_PATHS = [
  'M393,-50 C410,250 100,350 0,550 C-30,650 50,800 0,902 L393,902 Z',
  'M393,-150 C400,150 50,250 0,420 C-30,530 30,700 0,902 L393,902 Z',
  'M393,-250 C390,80 20,170 0,300 C-30,400 10,580 0,902 L393,902 Z',
  'M393,400 C350,550 200,750 100,820 C50,860 0,840 0,902 L393,902 Z',
];

const WAVE_VECTORS = [
  { x1: '0.8', y1: '0', x2: '0.2', y2: '1' },
  { x1: '0.7', y1: '0', x2: '0.3', y2: '1' },
  { x1: '0.6', y1: '0', x2: '0.4', y2: '1' },
  { x1: '0.5', y1: '0', x2: '0.5', y2: '1' },
];

const WAVE_MOTION = [
  { duration: 6000, delay: 0, travel: -10 },
  { duration: 7000, delay: 500, travel: 8 },
  { duration: 8000, delay: 1000, travel: 12 },
  { duration: 5000, delay: 1500, travel: -6 },
];

/**
 * True while the enclosing navigator screen is focused. The tab navigator
 * keeps every visited tab mounted, so without this each tab's waves keep
 * animating (and compositing five full-screen layers a frame) while hidden.
 *
 * Same logic as @react-navigation's useIsFocused, but tolerant of being
 * rendered outside any navigator, where it simply reports focused.
 */
function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => (navigation ? navigation.isFocused() : true));

  useEffect(() => {
    if (!navigation) return;
    setFocused(navigation.isFocused());
    const unsubFocus = navigation.addListener('focus', () => setFocused(true));
    const unsubBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      unsubFocus();
      unsubBlur();
    };
  }, [navigation]);

  return focused;
}

/** True while the app is in the foreground. 'unknown' is only the initial read. */
function isForeground(state: AppStateStatus): boolean {
  return state === 'active' || state === 'unknown';
}

function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setForeground(isForeground(next)));
    return () => sub.remove();
  }, []);

  return foreground;
}

export function WaveBackground({ prefix = 'wave', waves = 4, animated = true }: WaveBackgroundProps) {
  const t = useTheme();
  // react-native-svg registers <Defs> by id. If only the <Stop> colours change
  // under a stable id the old gradient can stay cached, which showed up as the
  // settings screen keeping light waves after switching theme in place (it is
  // the one screen you can change the theme on without remounting it).
  const ns = `${prefix}-${t.isDark ? 'dark' : 'light'}`;
  const anims = useRef(WAVE_MOTION.map(() => new Animated.Value(0))).current;

  const screenFocused = useScreenFocused();
  const appForeground = useAppForeground();
  // Only drive the loops while someone can actually see them.
  const running = animated && screenFocused && appForeground;

  useEffect(() => {
    if (!running) return;

    if (__DEV__) console.log(`[waves] ${prefix}: start`);

    // Hold on to every loop we start so the cleanup can stop it. The previous
    // version only cleared the start-up timers, so once a loop was running it
    // ran until the app was killed, even after its view had gone.
    const loops: Animated.CompositeAnimation[] = [];
    const timers = WAVE_MOTION.slice(0, waves).map((m, i) =>
      setTimeout(() => {
        const loop = Animated.loop(
          Animated.sequence([
            Animated.timing(anims[i], { toValue: 1, duration: m.duration / 2, useNativeDriver: true }),
            Animated.timing(anims[i], { toValue: 0, duration: m.duration / 2, useNativeDriver: true }),
          ])
        );
        loops.push(loop);
        loop.start();
      }, m.delay)
    );

    return () => {
      timers.forEach(clearTimeout);
      // stop() leaves each Animated.Value where it is, so the waves freeze in
      // place on blur and pick up from there on focus rather than jumping.
      loops.forEach((loop) => loop.stop());
      if (__DEV__) console.log(`[waves] ${prefix}: stop`);
    };
  }, [running, waves, anims, prefix]);

  const waveStops: WaveStop[][] = [t.waves.wave1, t.waves.wave2, t.waves.wave3, t.waves.wave4].map(
    (w) => [...w]
  );

  return (
    <View key={ns} style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 393 852"
        preserveAspectRatio="none"
        style={StyleSheet.absoluteFill}
      >
        <Defs>
          <LinearGradient id={`base-gradient-${ns}`} x1="0" y1="0.5" x2="1" y2="0.5">
            {t.waves.base.map((stop, i) => (
              <Stop key={i} offset={`${i * 50}%`} stopColor={stop.color} />
            ))}
          </LinearGradient>
        </Defs>
        <Path d="M0,0 L393,0 L393,852 L0,852 Z" fill={`url(#base-gradient-${ns})`} />
      </Svg>

      {WAVE_PATHS.slice(0, waves).map((d, i) => {
        const layerStyle = animated
          ? {
              transform: [
                {
                  translateY: anims[i].interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, WAVE_MOTION[i].travel],
                  }),
                },
              ],
            }
          : undefined;

        const layer = (
          <Svg width="100%" height="100%" viewBox="0 0 393 852" preserveAspectRatio="none">
            <Defs>
              <ClipPath id={`clip-${ns}-${i + 1}`}>
                <Rect x="0" y="0" width="393" height="852" />
              </ClipPath>
              <LinearGradient id={`wave${i + 1}-${ns}`} {...WAVE_VECTORS[i]}>
                {waveStops[i].map((stop, s) => (
                  <Stop
                    key={s}
                    offset={s === 0 ? '0%' : s === 1 ? (i === 0 ? '45%' : '50%') : '100%'}
                    stopColor={stop.color}
                    stopOpacity={stop.opacity}
                  />
                ))}
              </LinearGradient>
            </Defs>
            <G clipPath={`url(#clip-${ns}-${i + 1})`}>
              <Path d={d} fill={`url(#wave${i + 1}-${ns})`} />
            </G>
          </Svg>
        );

        return animated ? (
          // Rasterise each moving layer once and let the compositor slide the
          // bitmap, instead of re-rendering a full-screen SVG curve every
          // frame. The layer's content never changes while it animates, which
          // is exactly the case these flags are for.
          <Animated.View
            key={i}
            shouldRasterizeIOS
            renderToHardwareTextureAndroid
            style={[StyleSheet.absoluteFill, { overflow: 'hidden' }, layerStyle]}
          >
            {layer}
          </Animated.View>
        ) : (
          <View key={i} style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
            {layer}
          </View>
        );
      })}
    </View>
  );
}
