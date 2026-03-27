/**
 * ui/chat/ChatMessage.tsx — Mesaj balonu bileşeni
 *
 * § 8  : React.memo — seq/id bazlı karşılaştırma
 *         isStreaming değişince re-render → cursor animasyonu
 */

import React, { memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import type { ChatMessage as ChatMessageType } from "../../hooks/useAIChat";

// ─── Cursor animasyonu ──────────────────────────────────────────────────────

const StreamingCursor = memo(() => (
  <Text style={styles.cursor}>▌</Text>
));
StreamingCursor.displayName = "StreamingCursor";

// ─── Hata etiketi ──────────────────────────────────────────────────────────

const ErrorBadge = memo(({ code }: { code: string }) => (
  <View style={styles.errorBadge}>
    <Text style={styles.errorBadgeText}>⚠ {code}</Text>
  </View>
));
ErrorBadge.displayName = "ErrorBadge";

// ─── Token sayacı ───────────────────────────────────────────────────────────

const TokenCount = memo(({ tokens }: { tokens: number }) => (
  <Text style={styles.tokenCount}>{tokens} token</Text>
));
TokenCount.displayName = "TokenCount";

// ─── ChatMessage ────────────────────────────────────────────────────────────

interface ChatMessageProps {
  message: ChatMessageType;
}

const ChatMessageComponent = ({ message }: ChatMessageProps) => {
  const isUser = message.role === "user";
  const isEmpty = message.content.length === 0 && message.isStreaming;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
          message.errorCode ? styles.bubbleError : null,
        ]}
      >
        {/* Yükleniyor (ilk token henüz gelmedi) */}
        {isEmpty ? (
          <ActivityIndicator size="small" color="#8b8b9e" style={styles.loadingIndicator} />
        ) : (
          <Text
            style={[styles.messageText, isUser ? styles.messageTextUser : styles.messageTextAssistant]}
            selectable
          >
            {message.content}
            {message.isStreaming && <StreamingCursor />}
          </Text>
        )}

        {/* Hata rozeti */}
        {message.errorCode && <ErrorBadge code={message.errorCode} />}

        {/* Token sayacı — tamamlanan assistant mesajlarında */}
        {!message.isStreaming && message.totalTokens !== null && !isUser && (
          <TokenCount tokens={message.totalTokens} />
        )}
      </View>
    </View>
  );
};

// Sadece content/isStreaming/errorCode değişince re-render
export const ChatMessage = memo(ChatMessageComponent, (prev, next) => {
  return (
    prev.message.content === next.message.content &&
    prev.message.isStreaming === next.message.isStreaming &&
    prev.message.errorCode === next.message.errorCode &&
    prev.message.totalTokens === next.message.totalTokens
  );
});
ChatMessage.displayName = "ChatMessage";

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    flexDirection: "row",
  },
  rowUser: {
    justifyContent: "flex-end",
  },
  rowAssistant: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "80%",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: "#4f46e5",
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: "#1e1e2e",
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: "#2e2e3e",
  },
  bubbleError: {
    borderColor: "#ef4444",
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
  },
  messageTextUser: {
    color: "#f8f8f2",
  },
  messageTextAssistant: {
    color: "#cdd6f4",
    fontFamily: "monospace",
  },
  cursor: {
    color: "#7c7cff",
    opacity: 0.9,
  },
  loadingIndicator: {
    marginVertical: 4,
    marginHorizontal: 8,
  },
  errorBadge: {
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: "#450a0a",
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  errorBadgeText: {
    color: "#fca5a5",
    fontSize: 11,
    fontFamily: "monospace",
  },
  tokenCount: {
    marginTop: 4,
    color: "#585868",
    fontSize: 11,
    alignSelf: "flex-end",
  },
});
