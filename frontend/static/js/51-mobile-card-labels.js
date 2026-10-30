(function(){
 var raf=0;
 function run(){
  raf=0;
  document.querySelectorAll("#app table.si-register,#app table.ta-table,#app .ops-settings table.dense").forEach(function(tb){
   var heads=Array.prototype.map.call(tb.querySelectorAll("thead th"),function(th){return th.textContent.trim()});
   tb.querySelectorAll("tbody tr").forEach(function(tr){
    var cells=Array.prototype.filter.call(tr.children,function(c){return c.tagName==="TD"});
    if(cells.length<2||cells.some(function(c){return c.hasAttribute("colspan")}))return;
    var off=heads.length-cells.length;
    cells.forEach(function(td,i){
     var l=heads[i+off];
     if(l&&td.getAttribute("data-label")!==l)td.setAttribute("data-label",l);
    });
   });
  });
 }
 new MutationObserver(function(){if(!raf)raf=requestAnimationFrame(run)}).observe(document.body,{childList:true,subtree:true});
 run();
})();