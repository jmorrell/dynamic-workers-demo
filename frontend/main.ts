// Entry point for the embeddable <dynamic-workers-demo> widget bundle
// (public/app.js). The standalone page loads this as a `type="module"` script —
// same-src module scripts execute
// once per page no matter how many embeds a post has — but guard the custom
// element definition anyway so a stray duplicate (classic script tag, HMR)
// stays harmless.

import { DynamicWorkersDemoElement } from './widget';

if (!customElements.get('dynamic-workers-demo')) {
	customElements.define('dynamic-workers-demo', DynamicWorkersDemoElement);
}
