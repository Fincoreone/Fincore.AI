import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Image,
  TextInput,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line } from 'react-native-svg';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { ComingSoonModal } from '../../components/ComingSoonModal';
import { HistoryDrawer } from '../../components/HistoryDrawer';
import { useChat, type ChatMessage } from '../../hooks/useChat';
import { API_BASE_URL } from '../../config';
import { apiPost } from '../../lib/api';
import { formatCurrency } from '../../lib/format';
import type { AnalysisResult } from '../../hooks/useScan';
import { useProfile } from '../../hooks/useProfile';
import { useUser } from '../../contexts/UserContext';
import type { ChatSession } from '../../hooks/useChatHistory';
import { MenuIcon, PlusIcon } from '../../components/icons';
import { WaveBackground } from '../../components/WaveBackground';
import { BottomInputBar } from '../../components/BottomInputBar';
import { AnimatedScreen } from '../../components/AnimatedScreen';
import { useTheme, type Theme } from '../../contexts/ThemeContext';
import { useSounds } from '../../lib/sounds';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time: string;
  insightCard?: {
    title: string;
    items: { label: string; amount: string; pct: number }[];
    total: string;
  };
}

function ChartIcon() {
  const t = useTheme();
  return (
    <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={t.primaryOnSurface} strokeWidth={2.5}>
      <Line x1={18} y1={20} x2={18} y2={10} />
      <Line x1={12} y1={20} x2={12} y2={4} />
      <Line x1={6} y1={20} x2={6} y2={14} />
    </Svg>
  );
}

function FaithSparklesIcon() {
  const t = useTheme();
  return (
    <Svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke={t.textPrimary} strokeWidth={2}>
      <Path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </Svg>
  );
}

function TypingIndicator() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);

  return (
    <View style={styles.typingContainer}>
      <View style={styles.faithAvatar}>
        <LinearGradient colors={t.gradients.avatarReversed} style={styles.faithAvatarGradient}>
          <Text style={styles.faithAvatarText}>F</Text>
        </LinearGradient>
      </View>
      <View style={styles.typingBubble}>
        <View style={styles.typingDots}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.typingDot, { opacity: 0.45 + (i * 0.2) }]} />
          ))}
        </View>
      </View>
    </View>
  );
}

/**
 * One chat bubble. Memoised so that, while Faith's reply streams in, only the
 * bubble receiving text re-renders. The hook keeps every other message object
 * by identity, so a shallow prop compare is enough to skip them.
 *
 * `insightCard` is only ever present on the demo data below; kept so that
 * branch renders exactly as before.
 */
type BubbleMessage = ChatMessage & { insightCard?: Message['insightCard'] };

let bubbleRenders = 0; // __DEV__ only: counted per reply, see FaithScreen

const MessageBubble = React.memo(function MessageBubble({
  msg,
  t,
  styles,
}: {
  msg: BubbleMessage;
  t: Theme;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (__DEV__) bubbleRenders += 1;

  const time = useMemo(
    () => msg.timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    [msg.timestamp]
  );

  if (msg.role === 'user') {
    return (
      <View style={styles.userMessageContainer}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{msg.content}</Text>
        </View>
        <Text style={styles.userTime}>{time}</Text>
      </View>
    );
  }

  return (
    <View style={styles.assistantMessageContainer}>
      <View style={styles.faithAvatar}>
        <LinearGradient colors={t.gradients.avatarReversed} style={styles.faithAvatarGradient}>
          <Text style={styles.faithAvatarText}>F</Text>
        </LinearGradient>
      </View>
      <View style={styles.assistantBubbleContainer}>
        <View style={styles.assistantBubble}>
          <Text style={styles.assistantText}>{msg.content}</Text>

          {msg.insightCard && (
            <View style={styles.insightCard}>
              <View style={styles.insightHeader}>
                <View style={styles.insightIconContainer}>
                  <ChartIcon />
                </View>
                <Text style={styles.insightTitle}>{msg.insightCard.title}</Text>
              </View>
              <View style={styles.insightItems}>
                {msg.insightCard.items.map((item) => (
                  <View key={item.label} style={styles.insightItem}>
                    <View style={styles.insightItemHeader}>
                      <Text style={styles.insightItemLabel}>{item.label}</Text>
                      <Text style={styles.insightItemAmount}>{item.amount}</Text>
                    </View>
                    <View style={styles.insightBarBg}>
                      <LinearGradient
                        colors={t.gradients.avatar}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 0 }}
                        style={[styles.insightBar, { width: `${item.pct}%` }]}
                      />
                    </View>
                  </View>
                ))}
              </View>
              <View style={styles.insightTotal}>
                <Text style={styles.insightTotalLabel}>Total</Text>
                <Text style={styles.insightTotalAmount}>{msg.insightCard.total}</Text>
              </View>
            </View>
          )}

          {msg.insightCard && (
            <Text style={[styles.assistantText, { marginTop: 12 }]}>
              That's <Text style={styles.boldText}>23% above</Text> your average. I'd suggest a weekly cap of £80. Shall I set that up?
            </Text>
          )}
        </View>
        <Text style={styles.assistantTime}>{time}</Text>
      </View>
    </View>
  );
});

const initialMessages: Message[] = [
  {
    id: '1',
    role: 'user',
    content: 'Why do I spend so much on weekends?',
    time: '9:31 AM',
  },
  {
    id: '2',
    role: 'assistant',
    content: "Good morning! 👋\n\nBased on your high Extraversion score, I noticed you tend to spend more on social activities at weekends. Want me to help you set a social budget?",
    time: '9:32 AM',
  },
  {
    id: '3',
    role: 'user',
    content: "Yeah that would be great! How much am I actually spending?",
    time: '9:33 AM',
  },
  {
    id: '4',
    role: 'assistant',
    content: "Here's your social spending breakdown for March:",
    time: '9:33 AM',
    insightCard: {
      title: 'Social Spending — March',
      items: [
        { label: 'Dining out', amount: '£187', pct: 45 },
        { label: 'Drinks & bars', amount: '£124', pct: 30 },
        { label: 'Events & tickets', amount: '£68', pct: 16 },
        { label: 'Other social', amount: '£37', pct: 9 },
      ],
      total: '£416',
    },
  },
];

const defaultSuggestions = [
  "Why do I overspend at weekends?",
  "Help me build an emergency fund",
  "Should I invest or pay off debt?",
  "How can I stop impulse buying?",
];

interface ScanContext {
  scan_id?: string;
  product_name?: string;
  overall_score?: number;
  estimated_price?: number;
  verdict?: string;
  category?: string;
}

export default function FaithScreen() {
  const t = useTheme();
  const styles = useMemo(() => makeStyles(t), [t]);
  const sounds = useSounds();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ scanContext?: string; profileQuestion?: string }>();
  const { userId } = useUser();
  const { initials, profile } = useProfile({ userId: userId ?? undefined });
  const {
    messages: chatMessages,
    input: inputText,
    setInput: setInputText,
    isTyping,
    sendMessage,
    startNewSession,
    loadSession,
    isLoadingSession,
    suggestions: dynamicSuggestions,
  } = useChat({ userId: userId ?? undefined });

  // Use dynamic suggestions if available, otherwise defaults
  const quickReplies = dynamicSuggestions.length > 0 ? dynamicSuggestions : [];
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [comingSoonModal, setComingSoonModal] = useState<{ open: boolean; feature: 'banking' | 'analytics' | 'blueprint' | 'voice' | null }>({ open: false, feature: null });

  // The composer sits over the empty state, so the suggestion chips and the
  // input bar collide once the keyboard pushes the composer up. Hide them
  // while typing -- someone with the keyboard open has already decided what
  // to ask. 'Will' events on iOS so the chips go before the keyboard animates.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const handledParamsRef = useRef<string | null>(null);

  // Auto-focus the input when landing on a fresh chat with no scan/profile
  // context queued up (that flow auto-sends a message instead)
  React.useEffect(() => {
    if (!params.scanContext && !params.profileQuestion) {
      inputRef.current?.focus();
    }
  }, []);

  // Handle initial context from scan or profile - start fresh session
  React.useEffect(() => {
    // Create a key from current params to detect new navigation
    const paramsKey = params.scanContext || params.profileQuestion || null;

    // Skip if no params or already handled this exact params
    if (!paramsKey || handledParamsRef.current === paramsKey) return;

    handledParamsRef.current = paramsKey;

    let contextMessage: string | null = null;

    // Check for scan context
    if (params.scanContext) {
      try {
        const scanContext: ScanContext = JSON.parse(params.scanContext);
        contextMessage = `I just scanned a product: ${scanContext.product_name || 'Unknown product'}. ` +
          (scanContext.overall_score ? `It scored ${scanContext.overall_score}/100. ` : '') +
          (scanContext.verdict ? `The verdict was: "${scanContext.verdict}". ` : '') +
          (scanContext.estimated_price ? `The price is ${formatCurrency(scanContext.estimated_price)}. ` : '') +
          `What do you think about this purchase?`;
      } catch {
        // Invalid JSON, ignore
      }
    }

    // Check for profile question
    if (!contextMessage && params.profileQuestion) {
      contextMessage = params.profileQuestion;
    }

    if (contextMessage) {
      // Clear existing messages and start fresh, then send
      startNewSession();
      // Use a ref to track the message to send after session starts
      const messageToSend = contextMessage;
      setTimeout(() => {
        sendMessage(messageToSend);
      }, 50);
    }
  }, [params.scanContext, params.profileQuestion, startNewSession, sendMessage]);

  // Dev-only instrumentation: how many state flushes and bubble renders one
  // streamed reply cost. Before memoisation, renders = flushes x messages.
  const streamStatsRef = useRef({ streaming: false, flushes: 0 });
  useEffect(() => {
    if (!__DEV__) return;
    const stats = streamStatsRef.current;
    const streaming = chatMessages.some((m) => m.streaming);
    if (streaming) {
      if (!stats.streaming) {
        stats.flushes = 0;
        bubbleRenders = 0;
      }
      stats.flushes += 1;
    } else if (stats.streaming) {
      console.log(
        `[chat] reply done: ${stats.flushes} flushes, ${bubbleRenders} bubble renders, ` +
          `${chatMessages.length} messages on screen`
      );
    }
    stats.streaming = streaming;
  }, [chatMessages]);

  const showEmpty = chatMessages.length === 0 && !isTyping && !isLoadingSession;

  const handleSuggestion = (text: string) => {
    sendMessage(text);
  };

  const handleNewChat = () => {
    startNewSession();
    inputRef.current?.focus();
  };

  const handleSelectSession = (session: ChatSession) => {
    loadSession(session.session_id);
  };

  const handleSend = () => {
    if (inputText.trim()) {
      sounds.playSend();
      sendMessage();
    }
  };

  const handlePlusPress = async () => {
    try {
      const pickerResult = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (pickerResult.canceled || !pickerResult.assets[0]) return;

      const manipulated = await ImageManipulator.manipulateAsync(
        pickerResult.assets[0].uri,
        [{ resize: { width: 1024 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );

      const { data } = await apiPost<{ success: boolean; analysis?: AnalysisResult; error?: string }>('/analyze', {
        image_base64: manipulated.base64,
        media_type: 'image/jpeg',
      });
      if (data?.success && data.analysis) {
        const a = { ...data.analysis };

        if (a.product_barcode) {
          try {
            const priceRes = await fetch(`${API_BASE_URL}/price-check`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ barcode: a.product_barcode, user_id: userId }),
            });
            const priceData = await priceRes.json();
            if (priceData.success && priceData.cheapest_price != null) {
              a.estimated_price = priceData.cheapest_price;
            }
          } catch { /* silent — keep Claude's estimate */ }
        }

        const msg =
          `I just scanned a product: ${a.product_identified}.` +
          (a.estimated_price ? ` Estimated price: ${formatCurrency(Number(a.estimated_price))}.` : '') +
          ` It scored ${a.overall_score}/100 — ${a.verdict} What do you think about this purchase?`;
        sendMessage(msg);
      }
    } catch {
      // Silent fail — picker or analysis errors shouldn't disrupt the chat
    }
  };

  return (
    <AnimatedScreen style={styles.container}>
      {/* Wave background */}
      <WaveBackground prefix="faith" />

      {/* Header — outside KAV so it stays fixed when keyboard appears */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.menuButton} onPress={() => setHistoryDrawerOpen(true)}>
            <MenuIcon />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerTitle}>Faith</Text>
            <Text style={styles.headerSubtitle}>Your financial AI companion</Text>
          </View>
          <TouchableOpacity
            style={styles.newChatButton}
            onPress={handleNewChat}
            accessibilityLabel="Start new chat"
            accessibilityHint="Clears the current conversation and starts fresh"
          >
            <PlusIcon />
          </TouchableOpacity>
          <TouchableOpacity style={styles.avatarButton} onPress={() => router.push({ pathname: '/profile', params: { openSettings: 'true' } })}>
            {profile?.photo_url ? (
              <Image source={{ uri: profile.photo_url }} style={styles.avatarImage} />
            ) : (
              <LinearGradient colors={t.gradients.avatar} style={styles.avatarGradient}>
                <View style={styles.avatarShine} />
                <Text style={styles.avatarText}>{initials}</Text>
              </LinearGradient>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={styles.keyboardDismissWrapper}>
        {/* Messages or Empty State */}
        {isLoadingSession ? (
          <View style={styles.emptyState}>
            <View style={styles.loadingSpinner}>
              <Text style={styles.loadingText}>Loading conversation...</Text>
            </View>
          </View>
        ) : showEmpty ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyBadge}>
              <LinearGradient
                colors={t.gradients.badge}
                locations={[0, 0.6, 1]}
                style={styles.emptyBadgeGradient}
              >
                <FaithSparklesIcon />
              </LinearGradient>
            </View>
            <Text style={styles.emptyTitle}>Hi, I'm Faith</Text>
            <Text style={styles.emptySubtitle}>Your personality-aware financial coach</Text>
            {!keyboardVisible && (
              <>
                <Text style={styles.suggestionLabel}>TRY ASKING</Text>
                <View style={styles.suggestionList}>
                  {defaultSuggestions.map((s) => (
                    <TouchableOpacity key={s} style={styles.suggestionChip} onPress={() => handleSuggestion(s)}>
                      <Text style={styles.suggestionText}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.messagesContainer}
            contentContainerStyle={styles.messagesContent}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
          >
            {/* Date divider */}
            <View style={styles.dateDivider}>
              <View style={styles.datePill}>
                <Text style={styles.dateText}>Today</Text>
              </View>
            </View>

            {chatMessages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} t={t} styles={styles} />
            ))}

            {/* Typing indicator */}
            {isTyping && <TypingIndicator />}

            {/* Quick replies - dynamic based on Faith's response */}
            {chatMessages.length > 0 && !isTyping && quickReplies.length > 0 && (
              <View style={styles.quickReplies}>
                {quickReplies.map((reply) => (
                  <TouchableOpacity key={reply} style={styles.quickReplyButton} onPress={() => sendMessage(reply)}>
                    <Text style={styles.quickReplyText}>{reply}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </ScrollView>
        )}

        <BottomInputBar
          ref={inputRef}
          activeScreen="faith"
          placeholder="Ask Faith anything..."
          value={inputText}
          onChangeText={setInputText}
          onSend={handleSend}
          onMicPress={() => setComingSoonModal({ open: true, feature: 'voice' })}
          onPlusPress={handlePlusPress}
          showMic={true}
          onNavigate={(screen) => {
            if (screen === 'profile') router.push('/profile');
            else if (screen === 'scan') router.push('/');
          }}
          onComingSoon={(feature) => {
            if (feature === 'banking') router.push('/banking');
            else if (feature === 'analytics') router.push('/analytics');
            else setComingSoonModal({ open: true, feature });
          }}
          bottomInset={insets.bottom}
        />
      </View>
      </TouchableWithoutFeedback>
      </KeyboardAvoidingView>

      <ComingSoonModal
        visible={comingSoonModal.open}
        onClose={() => setComingSoonModal({ open: false, feature: null })}
        feature={
          comingSoonModal.feature === 'banking' ? 'Banking'
          : comingSoonModal.feature === 'analytics' ? 'Analytics'
          : comingSoonModal.feature === 'voice' ? 'Voice Input'
          : 'Blueprint'
        }
        featureKey={comingSoonModal.feature === 'voice' ? 'premium' : comingSoonModal.feature || 'banking'}
        description={
          comingSoonModal.feature === 'banking'
            ? 'Connect your bank accounts and see all your transactions in one place, categorised by your spending personality.'
            : comingSoonModal.feature === 'analytics'
            ? 'Deep insights into your spending patterns, with personalised recommendations based on your OCEAN profile.'
            : comingSoonModal.feature === 'voice'
            ? 'Ask Faith anything hands-free. Voice input is on its way — join the list to get early access.'
            : 'See the full context behind your spending patterns and get a personalised action plan.'
        }
      />

      <HistoryDrawer
        visible={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        source="faith"
      />
    </AnimatedScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: t.background,
    overflow: 'hidden',
  },
  keyboardView: {
    flex: 1,
  },
  keyboardDismissWrapper: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  menuButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitleContainer: {
    flex: 1,
  },
  headerTitle: {
    fontSize: t.type.headline,
    fontWeight: '700',
    color: t.textPrimary,
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: t.type.caption,
    color: t.textFaint,
    marginTop: 2,
  },
  newChatButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: t.overlayFaint,
    borderWidth: 1,
    borderColor: t.overlaySubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: t.textMuted,
  },
  avatarGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarText: {
    fontSize: t.type.bodySmall,
    fontWeight: '600',
    color: t.textPrimary,
  },
  avatarShine: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 19,
    opacity: 0.3,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 48,
  },
  emptyBadge: {
    width: 72,
    height: 72,
    borderRadius: 22,
    overflow: 'hidden',
    marginBottom: 12,
    shadowColor: t.shadowBrand,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 32,
  },
  emptyBadgeGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: t.type.title,
    fontWeight: '700',
    color: t.textPrimary,
  },
  emptySubtitle: {
    fontSize: t.type.bodySmall,
    color: t.textMuted,
    marginTop: 4,
  },
  suggestionLabel: {
    fontSize: t.type.captionSmall,
    fontWeight: '600',
    color: t.textGhost,
    letterSpacing: 1.5,
    marginTop: 24,
    marginBottom: 8,
  },
  suggestionList: {
    width: '100%',
    gap: 8,
  },
  suggestionChip: {
    width: '100%',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: t.overlaySubtle,
    borderWidth: 1,
    borderColor: t.overlayMedium,
  },
  suggestionText: {
    fontSize: t.type.bodySmall,
    color: t.textSecondary,
  },
  loadingSpinner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: t.type.bodyCompact,
    color: t.textMuted,
  },
  typingContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 16,
    gap: 10,
  },
  typingBubble: {
    backgroundColor: t.surfaceCard,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: t.overlayBorder,
  },
  typingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 16,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: t.textNear,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  dateDivider: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  datePill: {
    backgroundColor: t.overlaySubtle,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  dateText: {
    fontSize: t.type.captionSmall,
    fontWeight: '500',
    color: t.textSecondary,
  },
  userMessageContainer: {
    alignItems: 'flex-end',
    marginBottom: 16,
  },
  userBubble: {
    maxWidth: '75%',
    backgroundColor: t.secondary,
    borderRadius: 18,
    borderBottomRightRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: t.shadowBrandSoft,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 6,
  },
  userText: {
    fontSize: t.type.bodyCompact,
    color: t.textPrimary,
    lineHeight: t.line.body,
  },
  userTime: {
    fontSize: t.type.tiny,
    color: t.textGhost,
    marginTop: 4,
    marginRight: 8,
  },
  assistantMessageContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 16,
    gap: 10,
  },
  faithAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: t.shadowBase,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  faithAvatarGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faithAvatarText: {
    fontSize: t.type.bodyCompact,
    fontWeight: '700',
    color: t.textPrimary,
  },
  assistantBubbleContainer: {
    maxWidth: '80%',
  },
  assistantBubble: {
    backgroundColor: t.surfaceCard,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: t.overlayBorder,
    shadowColor: t.shadowSoft,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 6,
  },
  assistantText: {
    fontSize: t.type.bodyCompact,
    color: t.textOnSurface,
    lineHeight: t.line.body,
  },
  boldText: {
    fontWeight: '700',
  },
  assistantTime: {
    fontSize: t.type.tiny,
    color: t.textGhost,
    marginTop: 4,
    marginLeft: 8,
  },
  insightCard: {
    marginTop: 12,
    backgroundColor: t.primaryTintFaint,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: t.primaryTintSubtle,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  insightIconContainer: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: t.primaryTintSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightTitle: {
    fontSize: t.type.caption,
    fontWeight: '700',
    color: t.primaryOnSurface,
  },
  insightItems: {
    gap: 8,
  },
  insightItem: {
    gap: 2,
  },
  insightItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  insightItemLabel: {
    fontSize: t.type.caption,
    color: t.textOnSurfaceSecondary,
  },
  insightItemAmount: {
    fontSize: t.type.caption,
    fontWeight: '600',
    color: t.textOnSurface,
  },
  insightBarBg: {
    height: 6,
    backgroundColor: t.primaryTintSubtle,
    borderRadius: 3,
    overflow: 'hidden',
  },
  insightBar: {
    height: '100%',
    borderRadius: 3,
  },
  insightTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: t.primaryTintSubtle,
  },
  insightTotalLabel: {
    fontSize: t.type.caption,
    fontWeight: '700',
    color: t.textOnSurface,
  },
  insightTotalAmount: {
    fontSize: t.type.body,
    fontWeight: '700',
    color: t.primaryOnSurface,
  },
  quickReplies: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginLeft: 38,
    marginTop: 4,
  },
  quickReplyButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: t.textNear,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: t.overlayBorder,
    shadowColor: t.shadowBase,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
  },
  quickReplyText: {
    fontSize: t.type.bodySmall,
    fontWeight: '500',
    color: t.secondary,
  },
});
