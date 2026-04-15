'use strict';
// Minimal service worker — no persistent storage of any resume data.
// The extension does not store or transmit resume information anywhere.
// All data lives only in the popup's JS context and the active tab's
// content script context, both of which are cleared when closed.
chrome.runtime.onInstalled.addListener(() => {
  console.log('HiringCafe Resume Scanner installed. Resume data is never stored.');
});
