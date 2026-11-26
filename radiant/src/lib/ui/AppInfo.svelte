<script lang="ts">
  import {onMount} from 'svelte';
  import type {AppController} from './controller.svelte';
  import type {PlatformInfo} from '../host/types';
  import {buildDiagnostics, recordDiagnostic} from './diagnostics';
  import {aiChoice} from './ai-engine.svelte';
  let {c}:{c:AppController}=$props();
  let info=$state<PlatformInfo|null>(null),message=$state(''),busy=$state(false);
  let report = $state('');
  let diagnosticsBusy = $state(false);
  let diagnosticsMessage = $state('');
  onMount(()=>{void c.host.platformInfo().then(result=>info=result).catch(err=>message=String(err));});
  async function check() {
    if (!c.host.checkUpdate || busy)return;
    busy=true;
    try {
      const update=await c.host.checkUpdate();
      if (!update){message='You have the latest version.';return;}
      try {
        const answer=await c.ask('Install Radiant '+update.version+'?','Save the current map before installing the signed update.',[{id:'install',label:'Install',primary:true},{id:'cancel',label:'Cancel'}]);
        if(answer!=='install'||(c.dirty && !await c.save()))return;
        message='Downloading update…';
        await update.install();
        message='Installed. Reopen Radiant to use the new version.';
      } finally {await update.close();}
    } catch(err){recordDiagnostic(c.host, 'update_failed');message=String(err);}
    finally{busy=false;}
  }

  async function previewDiagnostics() {
    diagnosticsBusy = true;
    diagnosticsMessage = '';
    report = '';
    try {
      report = await buildDiagnostics(c.host, c.diagnosticRenderSummary(), c.aiStatus, aiChoice.engine);
    } catch {
      diagnosticsMessage = 'Could not prepare diagnostics.';
    } finally {
      diagnosticsBusy = false;
    }
  }

  async function saveDiagnostics() {
    if (!report) return;
    diagnosticsBusy = true;
    diagnosticsMessage = '';
    try {
      if (await c.host.exportFile('Radiant diagnostics.json', 'application/json', new TextEncoder().encode(report))) {
        diagnosticsMessage = 'Diagnostics saved.';
      }
    } catch {
      diagnosticsMessage = 'Could not save diagnostics.';
    } finally {
      diagnosticsBusy = false;
    }
  }
</script>
<details><summary>Display and app information</summary>
  <label>Interface size <select aria-label="Interface size" value={c.interfaceScale} onchange={e=>c.setInterfaceScale(Number(e.currentTarget.value))}>
    <option value={1}>100%</option><option value={1.15}>115%</option><option value={1.25}>125%</option><option value={1.5}>150%</option>
  </select></label>
  {#if info}<p>Version {info.appVersion} · {info.os}</p>
    {#if info.os==='macos'}
      {#if info.highRefreshBuild === false}
        <p>This edition uses public WebKit APIs and the system frame rate.</p>
      {:else}
        <p>WebKit high refresh is {info.highRefreshEnabled ? 'enabled' : 'unavailable on this window'}.
          The high-refresh edition is distributed outside the Mac App Store. Radiant uses one guarded private WebKit setting for 120 Hz on compatible displays. If the setting is unavailable, the editor uses the system frame rate.</p>
      {/if}
    {/if}
    {#if info.updateChannel}<button class="btn bordered" disabled={busy} onclick={check}>Check for updates</button>{/if}
  {/if}
  {#if message}<p role="status">{message}</p>{/if}
  <button class="btn bordered" disabled={diagnosticsBusy} onclick={previewDiagnostics}>Preview diagnostics</button>
  {#if report}
    <p>This bundle contains technical settings and error categories. Review it before saving or sharing.</p>
    <textarea aria-label="Diagnostics bundle preview" readonly value={report} rows="12"></textarea>
    <button class="btn bordered" disabled={diagnosticsBusy} onclick={saveDiagnostics}>Save diagnostics JSON</button>
  {/if}
  {#if diagnosticsMessage}<p role="status">{diagnosticsMessage}</p>{/if}
</details>
<style>
  details{margin:8px 0}
  summary{cursor:pointer}
  p{font-size:12px}
  textarea{width:100%;max-height:260px;resize:vertical;overflow:auto;padding:8px;background:var(--panel);font:11px ui-monospace,monospace}
</style>
