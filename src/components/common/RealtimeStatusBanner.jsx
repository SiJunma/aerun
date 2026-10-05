import React, { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { notificationsResource } from '../../api/rtdb-notifications';
import { useI18n } from '../../contexts/I18nProvider';

/**
 * Says out loud when the forum has fallen back to polling.
 *
 * WHY THIS EXISTS. The failure this whole feature was built to avoid is a stream
 * that looks configured and delivers nothing: the old dead realtime was exactly
 * that, and nothing on screen distinguished it from working. So the transport is
 * OBSERVED rather than inferred — shared-poll only reports 'realtime' after an
 * event has actually arrived, never on connection — and this renders the honest
 * answer.
 *
 * SILENT IN THE GOOD CASE, and that is deliberate rather than unfinished. A
 * permanent "live" badge would be a second thing that can be wrong: it would
 * have to be maintained through every reconnect, and the member gains nothing
 * from it. Polling is a perfectly good transport; the member needs to hear about
 * it only when something is degraded.
 *
 * It also does NOT appear for a guest. Guests never subscribe (the rule's first
 * clause excludes them), so they are permanently on polling, and a banner that
 * cries wolf to every signed-out visitor is noise rather than a warning.
 */
const RealtimeStatusBanner = ({ uid }) => {
  const { t } = useI18n();
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!uid) {
      setDegraded(false);
      return undefined;
    }
    const resource = notificationsResource(uid);
    return resource.onTransportChange((transport) => {
      setDegraded(transport === 'polling');
    });
  }, [uid]);

  if (!degraded) return null;

  return (
    <div
      className="d-flex align-items-center justify-content-center gap-2 py-1 px-3 small text-muted"
      role="status"
      aria-live="polite"
    >
      <CloudOff size={13} className="flex-shrink-0" />
      {/* "Updates may be delayed" rather than "realtime is broken": the member is
          being told the thing they will notice, which is that a reply might not
          appear instantly — not the name of a transport they did not ask for. */}
      <span>{t('realtime.polling_notice', 'Обновления могут приходить с задержкой')}</span>
    </div>
  );
};

export default RealtimeStatusBanner;