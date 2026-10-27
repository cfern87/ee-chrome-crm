// The product's name, in one place.
//
// It previously appeared as four different things depending on which surface
// you were looking at: "Not Another Social CRM" in the manifest and the
// sign-in gate, "Social CRM" in the toolbar tooltip and the content script,
// "Messenger CRM" in the dashboard heading and all six panel headers, and
// "facebook-crm-extension" in package.json. Same app, four names.
//
// There is deliberately no "short name" here. A second sanctioned variant is
// how the drift started; surfaces that are tight on space wrap or shrink
// instead.

export const PRODUCT_NAME = 'Not Another Social CRM';

/**
 * The first sentence of every "the background service worker never answered"
 * error, so the person can tell which extension is at fault.
 */
export const WORKER_NOT_LOADED = `The ${PRODUCT_NAME} worker didn't load.`;

/** For filenames of things the user downloads. */
export const PRODUCT_SLUG = 'not-another-social-crm';
