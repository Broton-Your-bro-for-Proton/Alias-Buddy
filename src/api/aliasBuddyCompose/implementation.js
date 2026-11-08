/* Experiment API: a compose window fills its sender menu once, so an identity
   the add-on creates is missing there and cannot be selected. This rebuilds
   the menu the way Thunderbird itself does it when an account color changes
   (accountObserver in MsgComposeCommands.js). */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

this.aliasBuddyCompose = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    return {
      aliasBuddyCompose: {
        async refreshIdentities() {
          for (const win of Services.wm.getEnumerator("msgcompose")) {
            const menu = win.document.getElementById("msgIdentity");
            if (!menu || typeof win.FillIdentityList != "function") {
              continue;
            }
            const key = menu.getAttribute("identitykey");
            menu.menupopup.replaceChildren();
            win.FillIdentityList(menu);
            menu.selectedItem = menu.getElementsByAttribute("identitykey", key)[0];
            win.LoadIdentity(true);
          }
        },
      },
    };
  }
};
