import { useMicMeter } from '../../hooks/useMicMeter'
import { useSpeakerTest } from '../../hooks/useSpeakerTest'
import { selectedOrEmpty } from '../../lib/callHealth'
import Badge from '../Badge'
import Meter from '../Meter'

/**
 * Mic / speaker / ringtone selection with live meters and a speaker test.
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice, active: boolean }} props  active: tab is visible (runs the idle mic meter only then)
 */
export default function DeviceManagementTab({ twilio, active }) {
  const registered = twilio.deviceState === 'registered'
  const mic = useMicMeter({
    enabled: active && registered && !twilio.activeCall,
    inputId: twilio.selectedInput,
    releaseNow: Boolean(twilio.activeCall) || !registered,
    log: twilio.log,
  })
  const speaker = useSpeakerTest({ outputId: twilio.selectedOutput, fallbackTest: twilio.testSpeaker, log: twilio.log })

  return (
    <>
      <section className="panel">
        <h2>Device management</h2>
        <p className="hint">
          Mic: <code>device.audio.setInputDevice</code>. Speaker: <code>speakerDevices.set</code>. Ringtone:{' '}
          <code>ringtoneDevices.set</code>. All apply live, including mid-call. The list refreshes on the SDK{' '}
          <code>deviceChange</code> event. If the active mic is unplugged we fall back to the <code>default</code> mic
          automatically. Every change is logged with source <code>audio</code>.
        </p>
        <label>
          Microphone (input)
          <select
            value={selectedOrEmpty(twilio.selectedInput, twilio.inputDevices)}
            onChange={(e) => twilio.setInputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered'}
          >
            <option value="">Select mic</option>
            {twilio.inputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speaker (call audio)
          <select
            value={selectedOrEmpty(twilio.selectedOutput, twilio.outputDevices)}
            onChange={(e) => twilio.setOutputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered' || !twilio.outputSelectionSupported}
          >
            <option value="">Select speaker</option>
            {twilio.outputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ringtone output
          <select
            value={selectedOrEmpty(twilio.selectedRingtone, twilio.outputDevices)}
            onChange={(e) => twilio.setRingtoneDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered' || !twilio.outputSelectionSupported}
          >
            <option value="">Select ringtone device</option>
            {twilio.outputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {!twilio.outputSelectionSupported && twilio.deviceState === 'registered' && (
          <p className="hint">
            This browser does not support output device selection (speaker/ringtone use the system default).
          </p>
        )}
        <dl className="meta">
          <div>
            <dt>Mic (input) level {twilio.activeCall ? '· from call' : '· idle meter'}</dt>
            <dd>
              <Meter value={twilio.activeCall ? twilio.health.inputLevel : Math.max(mic.level, twilio.micLevel)} />
            </dd>
          </div>
          <div>
            <dt>Speaker (output) level {speaker.testing ? '· test tone' : twilio.activeCall ? '· from call' : ''}</dt>
            <dd>
              <Meter
                value={speaker.testing ? speaker.level : twilio.activeCall ? (twilio.health.outputLevel ?? 0) : 0}
              />
            </dd>
          </div>
        </dl>
        <div className="row">
          {(mic.trackMuted || mic.silent || (twilio.activeCall && twilio.health.micDead)) && (
            <Badge tone="error">Mic muted / silent{mic.trackMuted ? ' (track muted)' : ''}</Badge>
          )}
          {speaker.testing && speaker.level <= 0.01 && <Badge tone="warn">Measuring…</Badge>}
          {!speaker.testing && speaker.noOutput && <Badge tone="error">No output detected</Badge>}
          {speaker.mutedWarn && (
            <Badge tone="warn">
              Speaker may be muted or volume at 0, check system volume or the selected output device
            </Badge>
          )}
        </div>
        {speaker.heardPrompt && (
          <div className="banner incoming" role="status">
            <span>Did you hear the test tone?</span>
            <button type="button" onClick={() => speaker.answerHeard(true)}>
              Yes
            </button>
            <button type="button" className="ghost" onClick={() => speaker.answerHeard(false)}>
              No
            </button>
          </div>
        )}
        <div className="row">
          <button type="button" disabled={twilio.deviceState !== 'registered' || speaker.testing} onClick={speaker.run}>
            {speaker.testing ? 'Testing…' : 'Test speaker'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={twilio.deviceState !== 'registered'}
            onClick={twilio.refreshDevices}
          >
            Refresh list
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>Current devices</h2>
        {twilio.inputDevices.length + twilio.outputDevices.length === 0 && (
          <p className="hint">Register the Device to list audio devices.</p>
        )}
        <ul className="device-list">
          {twilio.inputDevices.map((d) => (
            <li key={`in-${d.id}`} data-active={d.id === twilio.selectedInput}>
              <span className="lvl">mic</span> {d.label}
              {d.id === twilio.selectedInput && <Badge>active</Badge>}
            </li>
          ))}
          {twilio.outputDevices.map((d) => (
            <li key={`out-${d.id}`} data-active={d.id === twilio.selectedOutput || d.id === twilio.selectedRingtone}>
              <span className="lvl">out</span> {d.label}
              {d.id === twilio.selectedOutput && <Badge>speaker</Badge>}
              {d.id === twilio.selectedRingtone && <Badge>ringtone</Badge>}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
