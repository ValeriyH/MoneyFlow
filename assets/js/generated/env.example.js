/**
 * env.example.js — Environment file sample. Copy it to assets/js/generated/env.js
 * locally (the server will do this automatically) and fill in your own address.
 *
 * Why a separate file: the backend address should not be in git. During
 * publication, GitHub Actions takes it from a repository secret and creates
 * this file on the fly. In the repository, only the sample remains.
 *
 * After creation, the env.js file is added to .gitignore.
 *  */
window.__MONEYFLOW_ENV__ = {
  APPS_SCRIPT_ENDPOINT: "https://script.google.com/macros/s/INSERT_YOUR_ADDRESS_HERE/exec",
};
