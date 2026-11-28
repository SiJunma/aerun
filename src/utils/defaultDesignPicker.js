// Guest/member theme pickers: the three built-in theme names come from the
// default-design cards and can change; the dictionary label is only the
// fallback while the cards are loading. Shared by ProfilePage (member
// picker), Navbar (guest picker) and DesignsTab (admin selects and the
// custom-card base-theme line) so the names cannot drift apart.
//
// A card is a LIST SUMMARY (id/key/name/showInList/...) — everything the
// picker renders. Applying a choice never fetches a list: the choice is a
// key, and DesignProvider resolves it with ONE single-record GET.
// Order is the historic picker order (light, dark, neutral).
export const BUILTIN_THEME_KEYS = ['light', 'dark', 'neutral'];

export const builtinThemeDictKey = (key) => (
  key === 'light' ? 'profile.theme_light' : key === 'dark' ? 'profile.theme_dark' : 'profile.theme_neutral'
);

export const defaultDesignCard = (cards, key) => (cards || []).find((d) => d.key === key);

// Card name when the cards have loaded, dictionary label while they load.
export const builtinThemeLabel = (cards, t, key) => (
  defaultDesignCard(cards, key)?.name || t(builtinThemeDictKey(key))
);

// Keys the picker renders: all three while the cards are loading; once
// loaded, only the visible ones. A key with no card at all stays visible
// (dictionary fallback) — a card missing from the list is not a hidden card.
export const visibleBuiltinThemeKeys = (cards) => {
  if (!cards || cards.length === 0) return [...BUILTIN_THEME_KEYS];
  return BUILTIN_THEME_KEYS.filter((key) => {
    const card = defaultDesignCard(cards, key);
    return !card || card.showInList;
  });
};
