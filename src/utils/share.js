/**
 * Вызывает нативное меню "Поделиться" операционной системы
 * либо копирует ссылку в буфер обмена при отсутствии поддержки.
 *
 * @param {Object} options
 * @param {string} options.title Заголовок темы или имя автора
 * @param {string} options.text Краткое описание или текст поста
 * @param {string} options.url Абсолютная ссылка
 * @param {Function} [options.onCopied] Callback при успешном копировании в буфер
 * @param {Function} [options.onError] Callback при ошибке
 */
export async function shareOrCopy({ title, text, url, onCopied, onError }) {
  const shareData = {
    title: title || document.title,
    text: text ? text.slice(0, 150) : undefined,
    url: url || window.location.href,
  };

  if (navigator.share && navigator.canShare && navigator.canShare(shareData)) {
    try {
      await navigator.share(shareData);
      return { shared: true };
    } catch (err) {
      // Пользователь закрыл системное меню шеринга (AbortError) — это не ошибка приложения
      if (err.name === 'AbortError') {
        return { aborted: true };
      }
      console.warn('[WebShare] Failed, falling back to clipboard:', err);
    }
  }

  // Fallback: запись в буфер обмена
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(shareData.url);
    } else {
      // Резервный метод для устаревших вебвью
      const textArea = document.createElement('textarea');
      textArea.value = shareData.url;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    onCopied?.();
    return { copied: true };
  } catch (clipErr) {
    console.error('[WebShare] Clipboard fallback failed:', clipErr);
    onError?.(clipErr);
    return { error: clipErr };
  }
}