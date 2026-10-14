import { useState } from 'react'
import './App.css'
import CallModal from './components/CallModal'
import DevicePanel from './components/DevicePanel'
import ErrorBanner from './components/ErrorBanner'
import Header from './components/Header'
import IncomingBanner from './components/IncomingBanner'
import LogsDrawer from './components/LogsDrawer'
import Tabs, { TabPane } from './components/Tabs'
import CallHealthTab from './components/tabs/CallHealthTab'
import CallingTab from './components/tabs/CallingTab'
import ConferenceCallTab from './components/tabs/ConferenceCallTab'
import DeviceManagementTab from './components/tabs/DeviceManagementTab'
import FailureCasesTab from './components/tabs/FailureCasesTab'
import OutboundOutcomesTab from './components/tabs/OutboundOutcomesTab'
import PowerLoopTab from './components/tabs/PowerLoopTab'
import PreflightTab from './components/tabs/PreflightTab'
import { useCallHangup } from './hooks/useCallHangup'
import { useHashTab } from './hooks/useHashTab'
import { useLeaveWarning } from './hooks/useLeaveWarning'
import { usePowerLoop } from './hooks/usePowerLoop'
import { usePreflight } from './hooks/usePreflight'
import { useTwilioDevice } from './hooks/useTwilioDevice'
import { ringClient } from './lib/api'
import { DEFAULT_IDENTITY, DEFAULT_TAB, TABS } from './lib/constants'

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
