import { useState, useCallback, useRef } from 'react';
import EventSource from 'react-native-sse';
import { API_BASE_URL } from '../config';
import { getCachedSessionToken } from '../lib/session';

export type MessageRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  streaming?: boolean;
}

export interface UseChatOptions {
  baseUrl?: string;
  userId?: string;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  input: string;
  setInput: (v: string) => void;
  isTyping: boolean;
  error: string | null;
  sendMessage: (text?: string) => Promise<void>;
  clearError: () => void;
  clearHistory: () => void;
  sessionId: string;
  startNewSession: () => string;
  loadSession: (sessionId: string) => Promise<void>;
  isLoadingSession: boolean;
  suggestions: string[];
}

function parseSuggestions(content: string): { cleanContent: string; suggestions: string[] } {
  const match = content.match(/\[SUGGESTIONS\]([\s\S]*?)\[\/SUGGESTIONS\]/);
  if (!match) {
    return { cleanContent: content, suggestions: [] };
  }

  const suggestionsBlock = match[1];
  const suggestions = suggestionsBlock
    .split('\n')
    .map(line => line.replace(/^-\s*/, '').trim())
    .filter(line => line.length > 0);

  const cleanContent = content.replace(/\[SUGGESTIONS\][\s\S]*?\[\/SUGGESTIONS\]/, '').trim();

  return { cleanContent, suggestions };
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function generateSessionId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function useChat({
  baseUrl = API_BASE_URL,
  userId,
}: UseChatOptions = {}): UseChatReturn {
  const [currentSessionId, setCurrentSessionId] = useState<string>(generateSessionId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string>(currentSessionId);

  // Keep ref in sync with state
  sessionIdRef.current = currentSessionId;

  const sendMessage = useCallback(
    async (text?: string) => {
      const trimmed = (text ?? input).trim();
      if (!trimmed || isTyping) return;

      setError(null);
      setInput('');
      setSuggestions([]);

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      setIsTyping(true);

      const assistantId = uid();
      let firstChunk = true;
      let fullContent = '';

      // Bedrock delivers many small chunks a second. Pushing each one into
      // state re-renders the whole conversation per chunk, which is what made
      // long chats stutter while Faith typed. Coalesce: mark dirty, flush at
      // most once per animation frame -- the screen cannot show more anyway.
      let flushHandle: number | null = null;
      const flush = () => {
        flushHandle = null;
        const { cleanContent: streamContent } = parseSuggestions(fullContent);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: streamContent } : m))
        );
      };
      const scheduleFlush = () => {
        if (flushHandle === null) flushHandle = requestAnimationFrame(flush);
      };
      const cancelFlush = () => {
        if (flushHandle !== null) {
          cancelAnimationFrame(flushHandle);
          flushHandle = null;
        }
      };

      // Close any existing connection
      eventSourceRef.current?.close();


      const sessionToken = getCachedSessionToken();
      const es = new EventSource(`${baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({
          message: trimmed,
          session_id: sessionIdRef.current,
        }),
      });

      eventSourceRef.current = es;

      es.addEventListener('message', (event: any) => {
        const data = event.data;

        if (data === '[DONE]') {
          cancelFlush();
          es.close();
          setIsTyping(false);

          // Parse suggestions from the final content
          const { cleanContent, suggestions: newSuggestions } = parseSuggestions(fullContent);
          setSuggestions(newSuggestions);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: cleanContent, streaming: false } : m
            )
          );
          return;
        }

        try {
          const chunk = JSON.parse(data) as string;
          fullContent += chunk;

          if (firstChunk) {
            // First chunk goes straight through so the typing indicator is
            // replaced by the bubble the instant Faith starts.
            firstChunk = false;
            setIsTyping(false);
            const { cleanContent: streamContent } = parseSuggestions(fullContent);
            setMessages((prev) => [
              ...prev,
              {
                id: assistantId,
                role: 'assistant' as const,
                content: streamContent,
                timestamp: new Date(),
                streaming: true,
              },
            ]);
          } else {
            scheduleFlush();
          }
        } catch (e) {
        }
      });

      es.addEventListener('error', (event: any) => {
        cancelFlush();
        es.close();
        setIsTyping(false);

        if (firstChunk) {
          // No content received yet, show error message
          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: 'assistant',
              content: "Sorry, I couldn't reach the server right now. Please try again.",
              timestamp: new Date(),
              streaming: false,
            },
          ]);
        } else {
          // Mark existing message as done, with whatever text arrived before
          // the drop (a flush may still have been pending).
          const { cleanContent } = parseSuggestions(fullContent);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: cleanContent, streaming: false } : m
            )
          );
        }
      });

    },
    [baseUrl, userId, input, isTyping]
  );

  const clearError = useCallback(() => setError(null), []);
  const clearHistory = useCallback(() => {
    setMessages([]);
    eventSourceRef.current?.close();
  }, []);

  const startNewSession = useCallback(() => {
    // If streaming, close the connection but keep the partial message
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      // Mark any streaming message as complete
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
      );
    }
    setIsTyping(false);

    const newSessionId = generateSessionId();
    sessionIdRef.current = newSessionId;
    setCurrentSessionId(newSessionId);
    setMessages([]);
    setSuggestions([]);
    return newSessionId;
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    setIsLoadingSession(true);
    setError(null);
    eventSourceRef.current?.close();

    try {
      const sessionToken = getCachedSessionToken();
      const response = await fetch(
        `${baseUrl}/users/conversations/${sessionId}`,
        { headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {} }
      );

      if (!response.ok) {
        throw new Error(`Failed to load session: ${response.status}`);
      }

      const data = await response.json();

      if (data.messages && Array.isArray(data.messages)) {
        const loadedMessages: ChatMessage[] = data.messages.map((msg: any) => ({
          id: msg.id || uid(),
          role: msg.role as MessageRole,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          streaming: false,
        }));
        setMessages(loadedMessages);
        setCurrentSessionId(sessionId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setIsLoadingSession(false);
    }
  }, [baseUrl, userId]);

  return {
    messages,
    input,
    setInput,
    isTyping,
    error,
    sendMessage,
    clearError,
    clearHistory,
    sessionId: currentSessionId,
    startNewSession,
    loadSession,
    isLoadingSession,
    suggestions,
  };
}
