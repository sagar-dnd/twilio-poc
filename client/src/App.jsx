import { useState } from 'react'
import './App.css'
import { useCallHangup, useHashTab, useLeaveWarning, usePowerLoop, usePreflight } from './hooks'
import { DEFAULT_IDENTITY, DEFAULT_TAB, TABS, ringClient } from './lib'
import { ConferenceCallTab, DeviceManagementTab } from './moreTabs'
import { CallHealthTab, CallingTab, FailureCasesTab, OutboundOutcomesTab, PowerLoopTab, PreflightTab } from './tabs'
import { CallModal, LogsDrawer } from './ui'
import { useTwilioDevice } from './useTwilioDevice'

// --- Header ------------------------------------------------------------------------------------

/**
 * @param {{ logCount: number, onOpenLogs: () => void }} props
 */
export function Header({ logCount, onOpenLogs }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-title">
          <h1>Twilio Voice SDK POC</h1>
          <p className="sub">SD-7331 · Device lifecycle, calls, audio, token refresh &amp; recovery</p>
        </div>
        <div className="header-actions">
          <button type="button" className="ghost logs-btn" onClick={onOpenLogs}>
            Logs <span className="count">{logCount}</span>
          </button>
          <a className="nav-link" href="/docs">
            Docs →
          </a>
        </div>
      </div>
    </header>
  )
}

// --- Error banner ------------------------------------------------------------------------------

/**
 * @param {{ message: string | null, onDismiss: () => void }} props
 */
export function ErrorBanner({ message, onDismiss }) {
  if (!message) return null
  return (
    <div className="banner error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  )
}

// --- Incoming call banner ----------------------------------------------------------------------

/**
 * Incoming call prompt (also shown while already on a call).
 * @param {{ call: import('@twilio/voice-sdk').Call | null, onAccept: () => void, onReject: () => void, onIgnore: () => void }} props
 */
export function IncomingBanner({ call, onAccept, onReject, onIgnore }) {
  if (!call) return null
  return (
    <div className="banner incoming" role="status">
      <span>Incoming from {call.parameters?.From || 'unknown'}</span>
      <button type="button" onClick={onAccept}>
        Accept
      </button>
      <button type="button" className="ghost" onClick={onReject}>
        Reject
      </button>
      <button type="button" className="ghost" onClick={onIgnore}>
        Ignore
      </button>
    </div>
  )
}

// --- Device panel ------------------------------------------------------------------------------

/**
 * Identity, Register / Unregister and token status.
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice, identity: string, onIdentityChange: (v: string) => void, busy: boolean, onRegister: () => void }} props
 */
export function DevicePanel({ twilio, identity, onIdentityChange, busy, onRegister }) {
  return (
    <section className="panel">
      <h2>1. Device</h2>
      <label>
        Identity
        <input
          value={identity}
          onChange={(e) => onIdentityChange(e.target.value)}
          disabled={twilio.deviceState === 'registered'}
          autoComplete="off"
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={busy || twilio.deviceState === 'registered' || twilio.deviceState === 'registering'}
          onClick={onRegister}
        >
          {busy || twilio.deviceState === 'registering' ? 'Registering…' : 'Register Device'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={twilio.deviceState === 'unregistered'}
          onClick={twilio.unregister}
        >
          Unregister / Destroy
        </button>
      </div>
      <dl className="meta">
        <div>
          <dt>State</dt>
          <dd data-state={twilio.deviceState}>{twilio.deviceState}</dd>
        </div>
        <div>
          <dt>Token TTL</dt>
          <dd>{twilio.tokenMeta ? `${twilio.tokenMeta.ttl}s` : '—'}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{twilio.tokenMeta ? new Date(twilio.tokenMeta.expiresAt).toLocaleTimeString() : '—'}</dd>
        </div>
      </dl>
    </section>
  )
}

// --- Tabs --------------------------------------------------------------------------------------

/**
 * Horizontal tab bar.
 * @param {{ tabs: { id: string, label: string }[], active: string, onSelect: (id: string) => void }} props
 */
export function Tabs({ tabs, active, onSelect }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={active === id ? 'tab active' : 'tab'}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}

/**
 * Keeps every tab mounted (state and the shared call survive tab switches); hides inactive ones.
 * @param {{ id: string, active: string, children: import('react').ReactNode }} props
 */
export function TabPane({ id, active, children }) {
  return (
    <div className="tab-pane" hidden={active !== id}>
      {children}
    </div>
  )
}

// --- App ---------------------------------------------------------------------------------------

const TAB_IDS = TABS.map((t) => t.id)

/**
 * Shell: owns the single shared Twilio Device and the state several tabs read
 * (identity, busy flag, power loop, conference room), then lays out the panels.
 */
export default function App() {
  const [identity, setIdentity] = useState(DEFAULT_IDENTITY)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  // Lifted so the modal's hang-up knows a conference leg is intentional.
  const [conferenceRoom, setConferenceRoom] = useState(null)

  const twilio = useTwilioDevice(identity)
  const preflight = usePreflight(identity, twilio.log)
  const loop = usePowerLoop(twilio)
  const [tab, selectTab] = useHashTab(TAB_IDS, DEFAULT_TAB)
  const onModalHangup = useCallHangup(twilio, conferenceRoom)

  useLeaveWarning(
    loop.running ||
      !!twilio.activeCall ||
      !!twilio.incomingCall ||
      !!loop.pendingEnd ||
      twilio.deviceState === 'registered'
  )

  async function onRegister() {
    setBusy(true)
    try {
      await twilio.register()
    } finally {
      setBusy(false)
    }
  }

  async function onCall() {
    setBusy(true)
    try {
      await twilio.connect({ to: to.trim() })
    } catch (e) {
      // The hook already sets the error banner; keep a breadcrumb for the UI action.
      twilio.log('warn', 'Connect click failed', e?.message || String(e), 'app')
    } finally {
      setBusy(false)
    }
  }

  async function onRingInbound() {
    setBusy(true)
    try {
      await ringClient(identity)
    } catch (e) {
      alert(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <Header logCount={twilio.logs.length} onOpenLogs={() => setLogsOpen(true)} />
      <ErrorBanner message={twilio.error} onDismiss={twilio.clearError} />
      <IncomingBanner
        call={twilio.incomingCall}
        onAccept={twilio.acceptIncoming}
        onReject={twilio.rejectIncoming}
        onIgnore={twilio.ignoreIncoming}
      />
      <DevicePanel
        twilio={twilio}
        identity={identity}
        onIdentityChange={setIdentity}
        busy={busy}
        onRegister={onRegister}
      />
      <Tabs tabs={TABS} active={tab} onSelect={selectTab} />

      <TabPane id="calling" active={tab}>
        <CallingTab
          twilio={twilio}
          identity={identity}
          busy={busy}
          loopRunning={loop.running}
          to={to}
          setTo={setTo}
          onCall={onCall}
          onRingInbound={onRingInbound}
        />
      </TabPane>
      <TabPane id="outcomes" active={tab}>
        <OutboundOutcomesTab twilio={twilio} />
      </TabPane>
      <TabPane id="power" active={tab}>
        <PowerLoopTab twilio={twilio} loop={loop} />
      </TabPane>
      <TabPane id="preflight" active={tab}>
        <PreflightTab twilio={twilio} preflight={preflight} />
      </TabPane>
      <TabPane id="health" active={tab}>
        <CallHealthTab twilio={twilio} />
      </TabPane>
      <TabPane id="devices" active={tab}>
        <DeviceManagementTab twilio={twilio} active={tab === 'devices'} />
      </TabPane>
      <TabPane id="conference" active={tab}>
        <ConferenceCallTab twilio={twilio} room={conferenceRoom} setRoom={setConferenceRoom} />
      </TabPane>
      <TabPane id="failures" active={tab}>
        <FailureCasesTab twilio={twilio} />
      </TabPane>

      {twilio.activeCall && (
        <CallModal
          call={twilio.activeCall}
          callState={twilio.callState}
          reconnecting={twilio.health.reconnecting}
          muted={twilio.muted}
          onToggleMute={twilio.toggleMute}
          onHangup={onModalHangup}
        />
      )}
      <LogsDrawer open={logsOpen} onClose={() => setLogsOpen(false)} logs={twilio.logs} onClear={twilio.clearLogs} />
    </div>
  )
}
