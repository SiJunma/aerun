package messaging

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

var (
	ErrMessageTextRequired      = errors.New("message text is required")
	ErrMessageTextTooLong       = errors.New("message text must not exceed 65536 characters")
	ErrConversationTitleTooLong = errors.New("conversation title must not exceed 256 characters")
	ErrNoRecipients             = errors.New("at least one recipient is required")
	ErrTooManyRecipients        = errors.New("too many recipients in conversation")
	ErrSelfMessageOnly          = errors.New("cannot start a direct conversation with only yourself")
)

// ValidateMessageText validates message presence and length.
func ValidateMessageText(text string) (string, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", ErrMessageTextRequired
	}
	if utf8.RuneCountInString(trimmed) > MaxDMMessageLen {
		return "", ErrMessageTextTooLong
	}
	return trimmed, nil
}

// ValidateConversationTitle validates title length if provided.
func ValidateConversationTitle(title string) (string, error) {
	trimmed := strings.TrimSpace(title)
	if utf8.RuneCountInString(trimmed) > MaxDMTitleLen {
		return "", ErrConversationTitleTooLong
	}
	return trimmed, nil
}

// ValidateParticipants cleans and validates the participant list.
// Returns unique recipient IDs (excluding the sender).
func ValidateParticipants(senderID string, recipientIDs []string) ([]string, error) {
	if senderID == "" {
		return nil, errors.New("sender ID is required")
	}

	seen := make(map[string]bool)
	var cleanRecipients []string

	for _, id := range recipientIDs {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || trimmed == senderID {
			continue
		}
		if !seen[trimmed] {
			seen[trimmed] = true
			cleanRecipients = append(cleanRecipients, trimmed)
		}
	}

	if len(cleanRecipients) == 0 {
		return nil, ErrNoRecipients
	}
	if len(cleanRecipients) > MaxDMParticipants {
		return nil, ErrTooManyRecipients
	}

	slices.Sort(cleanRecipients)
	return cleanRecipients, nil
}

// MakeDMUnreadDedupeKey constructs the deterministic dedupe key for first-unread DM emails.
// Example: dm:first-unread:{conversation}:{recipient}
func MakeDMUnreadDedupeKey(conversationID, recipientID string) string {
	return fmt.Sprintf("dm:first-unread:%s:%s", conversationID, recipientID)
}

// MakeTopicReplyDedupeKey constructs the deterministic dedupe key for
// topic-subscription reply emails.
// Example: topic-reply:first-unread:{post}:{recipient}
//
// The key is per POST rather than per topic: the enqueue path only fires on the
// first unread reply in a topic (Firebase parity), so one post can never
// produce two emails for the same subscriber, while the next unread wave —
// after everything was read — keys off a different post and sails through.
func MakeTopicReplyDedupeKey(postID, recipientID string) string {
	return fmt.Sprintf("topic-reply:first-unread:%s:%s", postID, recipientID)
}

// ClampLimit clamps page limit between 1 and MaxPageLimit.
func ClampLimit(limit, fallback int) int {
	if limit <= 0 {
		return fallback
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}
