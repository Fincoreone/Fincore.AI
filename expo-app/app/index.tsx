import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useUser } from '../contexts/UserContext';
import { useTheme, type Theme } from '../contexts/ThemeContext';

// The tagline animation finishes 1050ms after mount (700ms delay + 350ms).
// Hold the splash at least this long so it is never cut off, but no longer:
// the wait is measured from when the splash appeared, not from when the
// user data finished loading, so a slow network never adds to it.
const MIN_SPLASH_MS = 1100;

export default function SplashScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const router = useRouter();
  const { userName, userEmail, authProvider, hasCompletedOnboarding, isLoading } = useUser();

  const logoOpacity = useRef(new Animated.Value(0)).current;
  const logoScale = useRef(new Animated.Value(0.8)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const taglineTranslate = useRef(new Animated.Value(10)).current;
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    Animated.sequence([
      Animated.delay(250),
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 450,
          useNativeDriver: true,
        }),
        Animated.timing(logoScale, {
          toValue: 1,
          duration: 450,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    Animated.sequence([
      Animated.delay(700),
      Animated.parallel([
        Animated.timing(taglineOpacity, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.timing(taglineTranslate, {
          toValue: 0,
          duration: 350,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, []);

  // Navigate once user state is loaded AND the splash has been visible for
  // MIN_SPLASH_MS. Whichever finishes later decides; the two never stack.
  useEffect(() => {
    if (isLoading) return;

    const hasStartedOnboarding = Boolean(userName || userEmail || authProvider !== 'anonymous');
    const remaining = Math.max(0, MIN_SPLASH_MS - (Date.now() - mountedAt.current));

    const timer = setTimeout(() => {
      if (__DEV__) {
        console.log(`[splash] navigating after ${Date.now() - mountedAt.current}ms`);
      }
      if (!hasStartedOnboarding) {
        router.replace('/login');
      } else if (hasCompletedOnboarding) {
        router.replace('/(tabs)');
      } else {
        router.replace('/info');
      }
    }, remaining);

    return () => clearTimeout(timer);
  }, [isLoading, userName, userEmail, authProvider, hasCompletedOnboarding]);

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={t.gradients.main}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />

      <Animated.View
        style={[
          styles.logoContainer,
          {
            opacity: logoOpacity,
            transform: [{ scale: logoScale }],
          },
        ]}
      >
        <Text style={styles.fincoreText}>FINCORE</Text>
      </Animated.View>

      <Animated.Text
        style={[
          styles.tagline,
          {
            opacity: taglineOpacity,
            transform: [{ translateY: taglineTranslate }],
          },
        ]}
      >
        Reframe your financial decisions
      </Animated.Text>

      <Animated.View
        style={[
          styles.divider,
          {
            opacity: taglineOpacity,
            transform: [{ translateY: taglineTranslate }],
          },
        ]}
      />

      <Animated.Text
        style={[
          styles.slogan,
          {
            opacity: taglineOpacity,
            transform: [{ translateY: taglineTranslate }],
          },
        ]}
      >
        MAKE IT COUNT
      </Animated.Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fincoreText: {
    fontSize: t.type.displayHero,
    fontWeight: '700',
    color: t.textPrimary,
    letterSpacing: -0.5,
  },
  aiText: {
    fontSize: t.type.displayHero,
    fontWeight: '700',
    color: t.primaryDark,
    letterSpacing: -0.5,
    marginLeft: 6,
    textShadowColor: t.textShadowBrand,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 4,
  },
  tagline: {
    marginTop: 12,
    fontSize: t.type.body,
    color: t.textFaint,
  },
  divider: {
    width: 60,
    height: 1,
    backgroundColor: t.overlayMedium,
    marginTop: 16,
  },
  slogan: {
    marginTop: 12,
    fontSize: t.type.bodySmall,
    color: t.textGhost,
    letterSpacing: 3,
  },
});
