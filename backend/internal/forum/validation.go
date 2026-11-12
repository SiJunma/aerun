package forum

import (
	"errors"
	"strings"
	"unicode/utf8"
)

var (
	ErrTopicTitleRequired              = errors.New("topic title is required")
	ErrTopicTitleTooLong               = errors.New("topic title must not exceed 256 characters")
	ErrTopicTitleCRLF                  = errors.New("topic title must not contain line breaks")
	ErrPostContentRequired             = errors.New("post content is required")
	ErrPostContentTooLong              = errors.New("post content must not exceed 65536 characters")
	ErrCategoryIDRequired              = errors.New("category_id is required")
	ErrReputationSelfVote              = errors.New("cannot vote for yourself")
	ErrReputationInvalidValue          = errors.New("reputation value must be 1 or -1")
	ErrReputationCommentTooLong        = errors.New("reputation comment must not exceed 1024 characters")
	ErrReputationVoterOrTargetRequired = errors.New("voter and target are required")
	ErrGuestNicknameRequired           = errors.New("guest nickname is required")
	ErrGuestNicknameTooLong            = errors.New("guest nickname must not exceed 64 characters")
	ErrGuestNicknameCRLF               = errors.New("guest nickname must not contain line breaks")
	ErrTopicDescriptionTooLong         = errors.New("topic description must not exceed 200 characters")
)

// ValidateReputationVote validates voter vs target, vote value and comment length.
//
// Newlines in the comment ARE allowed here, unlike for nicknames/titles:
// a comment is stored as a body, may be multi-line, and is never placed
// in a header. A newline is not the enemy — an unescaped header line is.
func ValidateReputationVote(voterID, targetID string, value int, comment string) (int, string, error) {
	if voterID == "" || targetID == "" {
		return 0, "", ErrReputationVoterOrTargetRequired
	}
	if voterID == targetID {
		return 0, "", ErrReputationSelfVote
	}
	if value != 1 && value != -1 {
		return 0, "", ErrReputationInvalidValue
	}
	trimmedComment := strings.TrimSpace(comment)
	if utf8.RuneCountInString(trimmedComment) > MaxReputationCommentLen {
		return 0, "", ErrReputationCommentTooLong
	}
	return value, trimmedComment, nil
}

// hasCRLF reports whether value contains a carriage return or line feed —
// the bytes that turn one header line in an outgoing mail into two (SEC-07).
func hasCRLF(value string) bool {
	return strings.ContainsAny(value, "\r\n")
}

// ValidateTopicTitle validates title length and presence.
//
// A title is used as the subject of a notification mail (the template
// "New reply in: {TOPIC_TITLE}"), and after 2026 the values that reach
// subjects are no longer escaped — see renderEmailFromTemplate. A newline
// inside a title would inject a second header line into every letter the
// forum sends about that topic, so newlines are refused at the point of
// writing rather than relying on every consumer to sanitise.
func ValidateTopicTitle(title string) (string, error) {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return "", ErrTopicTitleRequired
	}
	if hasCRLF(trimmed) {
		return "", ErrTopicTitleCRLF
	}
	if utf8.RuneCountInString(trimmed) > MaxTopicTitleLen {
		return "", ErrTopicTitleTooLong
	}
	return trimmed, nil
}

// ValidateTopicDescription validates the topic's OPTIONAL short description
// ("Краткое описание"). Unlike the title it may be EMPTY — both client forms
// render an optional input — so only the upper bound is enforced here. The
// result is always trimmed: leading/trailing whitespace is form noise, not
// content.
//
// Newlines ARE allowed here, unlike for the title: a description is body
// content (it may be several lines) and never reaches a header. Refusing
// newlines here would break legitimate multi-line descriptions while
// closing nothing.
func ValidateTopicDescription(description string) (string, error) {
	trimmed := strings.TrimSpace(description)
	if utf8.RuneCountInString(trimmed) > MaxTopicDescriptionLen {
		return "", ErrTopicDescriptionTooLong
	}
	return trimmed, nil
}

// ValidatePostContent validates content length and presence.
func ValidatePostContent(content string) (string, error) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return "", ErrPostContentRequired
	}
	if utf8.RuneCountInString(trimmed) > MaxPostContentLen {
		return "", ErrPostContentTooLong
	}
	return trimmed, nil
}

// ValidateGuestNickname validates a guest's display name.
//
// Nicknames are interpolated into a DM subject ("New Direct Message from
// {SENDER_NAME}") just like a topic title, so the same newline-injection
// argument applies: a nickname that ends a header line would write one.
func ValidateGuestNickname(nickname string) (string, error) {
	trimmed := strings.TrimSpace(nickname)
	if trimmed == "" {
		return "", ErrGuestNicknameRequired
	}
	if hasCRLF(trimmed) {
		return "", ErrGuestNicknameCRLF
	}
	if utf8.RuneCountInString(trimmed) > MaxGuestNicknameLen {
		return "", ErrGuestNicknameTooLong
	}
	return trimmed, nil
}

// ClampLimit enforces page size bounds between 1 and MaxPageLimit.
func ClampLimit(limit, defaultLimit int) int {
	if limit <= 0 {
		if defaultLimit <= 0 {
			return DefaultPageLimit
		}
		return defaultLimit
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}
