using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Controls;

namespace CachePilotMonitor {
 // Configuration export only. No commands go through the telemetry pipe.
 public static class MonitorGpuControls {
  public static void RenderSource(Window window,Dictionary<string,object> sample){
   var label=(TextBlock)window.FindName("GpuSourceMode");
   label.Text=sample==null?"来源启动模式：无有效数据":"来源 PID "+sample["pid"]+" 上报启动模式："+sample["device"]+"（非实际 GPU 执行证明）";
  }
  public static void Attach(Window window,string appRoot,string storageMode,string profileId){
   GpuSettingsStore store;
   var enabled=(CheckBox)window.FindName("GpuEnabled");
   var python=(TextBox)window.FindName("GpuPythonPath");
   var model=(TextBox)window.FindName("GpuModelPath");
   var state=(TextBlock)window.FindName("GpuSaveState");
   var save=(Button)window.FindName("SaveGpuButton");
   var reload=(Button)window.FindName("ReloadGpuButton");
   try{store=GpuSettingsStore.Create(appRoot,storageMode,profileId);}catch{
    ((TextBlock)window.FindName("GpuConfigPath")).Text="配置位置无效 · "+storageMode+" / "+profileId;
    state.Text="配置位置无法核验：保存已禁用；未改文件，未回退其它目录。";
    save.IsEnabled=reload.IsEnabled=enabled.IsEnabled=python.IsEnabled=model.IsEnabled=false;return;
   }
   ((TextBlock)window.FindName("GpuConfigPath")).Text="配置："+store.StorageMode+" / "+store.ProfileId+" · "+store.ConfigPath;
   string revision=null;bool applying=false;
   Action refresh=()=>{
    applying=true;
    try{
     var snapshot=store.Load();revision=snapshot.Revision;
     enabled.IsChecked=snapshot.Enabled;python.Text=snapshot.PythonPath;model.Text=snapshot.ModelPath;
     state.Text=revision=="missing"?"默认 off / estimate · 尚未保存；未接宿主，当前插件不变":"已读取候选配置："+snapshot.Device+" · 待宿主接入并重载，当前插件不变";
     save.IsEnabled=true;
    }catch{
     revision=null;enabled.IsChecked=false;python.Text="";model.Text="";save.IsEnabled=false;
     state.Text="配置读取失败：路径、权限、内容或数字精度不受本候选支持；未重置/未覆盖，也未回退其它目录。";
    }finally{applying=false;python.IsEnabled=model.IsEnabled=enabled.IsChecked==true;}
   };
   RoutedEventHandler modeChanged=(s,e)=>{python.IsEnabled=model.IsEnabled=enabled.IsChecked==true;if(!applying)state.Text="有未保存更改 · 当前插件不变";};
   TextChangedEventHandler textChanged=(s,e)=>{if(!applying)state.Text="有未保存更改 · 当前插件不变";};
   RoutedEventHandler saveChanged=(s,e)=>{
    if(revision==null)return;
    try{
     var snapshot=store.Save(enabled.IsChecked==true,python.Text,model.Text,revision);revision=snapshot.Revision;
     state.Text="已保存候选配置："+snapshot.Device+" · 待宿主接入并重载；当前插件未切换，实际 GPU 执行未验证";
    }catch{
     // Keep the user's unsaved fields; never silently reload and retry a stale write.
     state.Text="保存未确认：路径、权限或版本冲突；未自动重试，请重新读取核对。";
    }
   };
   RoutedEventHandler reloadChanged=(s,e)=>refresh();
   enabled.Checked+=modeChanged;enabled.Unchecked+=modeChanged;
   python.TextChanged+=textChanged;model.TextChanged+=textChanged;
   save.Click+=saveChanged;reload.Click+=reloadChanged;
   window.Closed+=(s,e)=>{enabled.Checked-=modeChanged;enabled.Unchecked-=modeChanged;python.TextChanged-=textChanged;model.TextChanged-=textChanged;save.Click-=saveChanged;reload.Click-=reloadChanged;};
   refresh();
  }
 }
}
