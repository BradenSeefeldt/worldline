// Settings → Sync: turn it on, pair another device (a QR code / a code to paste), or join from this device.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { useStore } from '../data/store';
import { createSync, currentSecret, joinSync, leaveSync } from '../data/syncEngine';
import { pairingCode, parsePairingCode } from '../lib/sync/wire';
import { ask } from './Confirm';
import { cls } from '../lib/format';
import { isApp } from '../lib/platform';

function Box({ title, foot, children }: { title?: string; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-grp">
      {title && <h3>{title}</h3>}
      <div className="st-box">{children}</div>
      {foot && <p className="st-foot">{foot}</p>}
    </div>
  );
}
function Row({ title, note, children }: { title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-lab"><b>{title}</b>{note && <span>{note}</span>}</div>
      {children && <div className="st-ctl">{children}</div>}
    </div>
  );
}
const ago = (t: number) => (!t ? 'not yet' : Date.now() - t < 60_000 ? 'just now' : `${formatDistanceToNowStrict(t)} ago`);
const here = () => (isApp() ? 'Mac' : 'iPhone');

export function SyncSettings() {
  const sync = useStore((s) => s.sync);
  const [secret, setSecret] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => void currentSecret().then(setSecret), [sync.on]);

  const turnOn = async () => {
    setBusy(true);
    setSecret(await createSync());
    setBusy(false);
  };
  const turnOff = async () => {
    if (!(await ask({ title: 'Stop syncing on this device?', body: 'Its data stays here, and your other devices carry on syncing with each other. You can join again with the pairing code.', confirm: 'Stop syncing' }))) return;
    await leaveSync();
    setSecret(null);
  };

  if (!sync.on)
    return (
      <>
        <Box foot="Each device keeps a full copy and works offline; changes merge when they reach each other. Messages travel end-to-end encrypted through public relays — no account, nothing stored anywhere else.">
          <Row title="Sync between your devices" note="Your Mac and iPhone keep the same calendars, tasks, habits, projects and scheduling links">
            <button className="ce-btn primary" disabled={busy} onClick={() => void turnOn()}>{busy ? 'Turning on…' : 'Turn on sync'}</button>
          </Row>
          <Row title="Join from this device" note={`Already syncing on another device? Use its pairing code. This ${here()}’s own data is replaced by your synced calendar.`}>
            <button className="ce-btn" onClick={() => setJoining(true)}>Join…</button>
          </Row>
        </Box>
        {joining && <Join onClose={() => setJoining(false)} />}
      </>
    );

  const others = Object.entries(sync.devices);
  return (
    <>
      <Box title="This device">
        <Row
          title={<><i className={cls('st-dot', sync.state === 'offline' ? 'off' : sync.state === 'connecting' ? '' : 'ok')} />{{ off: 'Off', connecting: 'Connecting…', synced: 'Syncing', sending: 'Sending…', offline: 'Offline — changes are kept and sent when it’s back' }[sync.state]}</>}
          note={`Last sent ${ago(sync.lastOut)} · last received ${ago(sync.lastIn)}`}
        />
        <Row title="Other devices" note={others.length ? others.map(([k, t]) => `…${k.slice(-4)} (heard from ${ago(t)})`).join(' · ') : 'None yet — pair one below'} />
      </Box>
      {secret && <Pair secret={secret} />}
      <Box>
        <Row title="Stop syncing on this device" note="Its data stays here; your other devices carry on">
          <button className="ce-btn subtle-danger" onClick={() => void turnOff()}>Stop syncing…</button>
        </Row>
      </Box>
    </>
  );
}

/** The QR code and the code itself, for another device to join. */
function Pair({ secret }: { secret: string }) {
  const code = pairingCode(secret);
  const [svg, setSvg] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => void QRCode.toString(code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then(setSvg), [code]);
  return (
    <Box title="Pair a device" foot="Anyone with this code can read and change your synced data — share it only with your own devices.">
      <div className="sy-pair">
        <div className="sy-qr" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="sy-steps">
          <b>On your iPhone</b>
          <ol>
            <li>Open Worldline (added to your Home Screen).</li>
            <li>Settings → Sync → <b>Join…</b></li>
            <li>Scan this code — or paste it (copy it here; with the same Apple ID it’s on the iPhone’s clipboard too).</li>
          </ol>
          <div className="sy-code">
            <code>{code}</code>
            <button className="ce-btn" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true))}>{copied ? 'Copied ✓' : 'Copy'}</button>
          </div>
        </div>
      </div>
    </Box>
  );
}

/** Join: scan the other device's QR code with the camera, or paste its code. */
function Join({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const canScan = !isApp() && !!navigator.mediaDevices?.getUserMedia;

  const go = async (raw: string) => {
    const secret = parsePairingCode(raw);
    if (!secret) return setErr('That isn’t a Worldline pairing code (it starts with “wlsync1:”).');
    if (!(await ask({ title: 'Join your synced calendar?', body: `This ${here()}’s own calendars, tasks, habits and projects are replaced by the ones from your other devices. (Settings → Data & Backups can save a backup first.)`, confirm: 'Join' }))) return;
    await joinSync(secret);
    onClose();
  };

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
      stream = s;
      const v = video.current!;
      v.srcObject = s;
      void v.play();
      const tick = () => {
        if (done) return;
        if (v.videoWidth) {
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(v, 0, 0);
          const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
          if (found?.data && parsePairingCode(found.data)) {
            done = true;
            setScanning(false);
            void go(found.data);
            return;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    }, () => {
      setScanning(false);
      setErr('The camera isn’t available — paste the code instead.');
    });
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box title="Join">
      {scanning ? (
        <div className="sy-scan">
          <video ref={video} playsInline muted />
          <button className="ce-btn" onClick={() => setScanning(false)}>Cancel</button>
        </div>
      ) : (
        <>
          {canScan && <Row title="Scan the pairing code" note="On your Mac: Settings → Sync shows it"><button className="ce-btn primary" onClick={() => { setErr(''); setScanning(true); }}>Scan with camera</button></Row>}
          <div className="st-row sy-paste">
            <input className="st-in" placeholder="…or paste the code (wlsync1:…)" value={text} onChange={(e) => { setText(e.target.value); setErr(''); }} />
            <button className="ce-btn" disabled={!text.trim()} onClick={() => void go(text)}>Join</button>
            <button className="ce-btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
      {err && <p className="st-msg bad sy-err">{err}</p>}
    </Box>
  );
}
