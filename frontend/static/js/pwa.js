"use strict";
if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(error=>console.warn('Solar91 service worker registration failed; offline navigation fallback is unavailable.',error)));}
let _installEvt=null;const _ib=document.getElementById('installApp');const _installHelp=document.getElementById('installHelp');
function showInstallHelp(message){
  document.getElementById('installHelpMessage').textContent=message;
  if(!_installHelp.open)_installHelp.showModal();
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();_installEvt=e;});
_ib.addEventListener('click',async()=>{
  if(!_installEvt){showInstallHelp('Your browser is not offering the automatic install prompt right now. Open this portal in your browser and use its install option:');return;}
  const installEvent=_installEvt;_installEvt=null;
  try{
    await installEvent.prompt();
    const choice=await installEvent.userChoice;
    if(choice.outcome!=='accepted')showInstallHelp('The install prompt was dismissed. You can still install Solar91 O&M from your browser menu:');
  }catch(error){
    console.error('Solar91 app installation prompt failed',error);
    showInstallHelp('The automatic install prompt could not be opened. You can still install Solar91 O&M from your browser menu:');
  }
});