// Whether this build is running as a loaded-unpacked (developer) extension.
//
// WHY: several panels carry instructions only a developer can act on — which
// OAuth clients to register in Google Cloud, which git hooks rebuild dist/,
// what to run when the loaded build is stale. Shipped to a customer those are
// noise at best and alarming at worst: nobody who installed this from the Web
// Store can paste a client id into manifest.json, and a paragraph about
// post-commit hooks makes a finished product read like somebody's checkout.
//
// Chrome adds `update_url` to the manifest it hands back for anything installed
// from a store; a folder loaded through "Load unpacked" has none, and none is
// declared in our source manifest. Reading it is synchronous and free —
// chrome.management.getSelf() reports installType directly but costs a
// "management" permission on every install, which is a much worse trade for a
// boolean that only decides whether to render a paragraph.
//
// Fails closed: anything unexpected reads as production, so a customer can
// never be shown developer instructions by accident.
export const IS_UNPACKED: boolean = (() => {
  try {
    const m = chrome.runtime.getManifest() as chrome.runtime.Manifest & { update_url?: string };
    return !m.update_url;
  } catch {
    return false;
  }
})();
