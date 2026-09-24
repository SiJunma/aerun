package forum_test

import (
	"strings"
	"testing"

	"github.com/SiJunma/aerun/backend/internal/forum"
)

func TestValidateTopicTitle(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr error
		want    string
	}{
		{
			name:    "valid title",
			input:   " Hello World ",
			wantErr: nil,
			want:    "Hello World",
		},
		{
			name:    "empty title",
			input:   "   ",
			wantErr: forum.ErrTopicTitleRequired,
		},
		{
			name:    "too long title",
			input:   strings.Repeat("a", forum.MaxTopicTitleLen+1),
			wantErr: forum.ErrTopicTitleTooLong,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := forum.ValidateTopicTitle(tc.input)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if tc.wantErr == nil && got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestValidatePostContent(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr error
		want    string
	}{
		{
			name:    "valid content",
			input:   " Some post text ",
			wantErr: nil,
			want:    "Some post text",
		},
		{
			name:    "empty content",
			input:   " \n\t ",
			wantErr: forum.ErrPostContentRequired,
		},
		{
			name:    "too long content",
			input:   strings.Repeat("x", forum.MaxPostContentLen+1),
			wantErr: forum.ErrPostContentTooLong,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := forum.ValidatePostContent(tc.input)
			if err != tc.wantErr {
				t.Fatalf("expected error %v, got %v", tc.wantErr, err)
			}
			if tc.wantErr == nil && got != tc.want {
				t.Fatalf("expected %q, got %q", tc.want, got)
			}
		})
	}
}

func TestClampLimit(t *testing.T) {
	if got := forum.ClampLimit(0, 20); got != 20 {
		t.Fatalf("expected 20, got %d", got)
	}
	if got := forum.ClampLimit(-5, 10); got != 10 {
		t.Fatalf("expected 10, got %d", got)
	}
	if got := forum.ClampLimit(500, 20); got != forum.MaxPageLimit {
		t.Fatalf("expected %d, got %d", forum.MaxPageLimit, got)
	}
	if got := forum.ClampLimit(15, 20); got != 15 {
		t.Fatalf("expected 15, got %d", got)
	}
}
