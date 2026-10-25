using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Controls;

namespace CachePilotMonitor {
 // One selection owner shared by the real window and regression tests.
 public sealed class MonitorSelection : IDisposable {
  readonly ComboBox choices;bool rebuilding;string rendered="";
  public int SelectedPid {get;private set;}
  public void PinPid(int pid){if(pid<=0)throw new ArgumentOutOfRangeException("pid");SelectedPid=pid;rendered="\0";}
  public MonitorSelection(ComboBox choices){this.choices=choices;choices.SelectionChanged+=Changed;}
  void Changed(object sender,SelectionChangedEventArgs args){
   if(!rebuilding && choices.SelectedItem!=null)SelectedPid=(int)((ComboBoxItem)choices.SelectedItem).Tag;
  }
  public void Update(Dictionary<string,object>[] samples){
   string key=String.Join(",",samples.Select(v=>v["pid"]+":"+v["startedAt"]+":"+v["version"]));
   if(key==rendered)return;
   rebuilding=true;
   try{
    choices.Items.Clear();
    foreach(var sample in samples){
     int pid=Convert.ToInt32(sample["pid"]);var item=new ComboBoxItem{Content="v"+sample["version"]+" · PID "+pid,Tag=pid};choices.Items.Add(item);
     if(pid==SelectedPid)choices.SelectedItem=item;
    }
    if(SelectedPid==0 && choices.Items.Count>0){choices.SelectedIndex=0;SelectedPid=(int)((ComboBoxItem)choices.SelectedItem).Tag;}
    else if(SelectedPid>0 && choices.SelectedItem==null){
     var waiting=new ComboBoxItem{Content="PID "+SelectedPid+" · 等待有效数据",Tag=SelectedPid};choices.Items.Add(waiting);choices.SelectedItem=waiting;
    }
    rendered=key;
   }finally{rebuilding=false;}
  }
  public void ChoosePid(int pid){
   foreach(ComboBoxItem item in choices.Items)if((int)item.Tag==pid){choices.SelectedItem=item;return;}
   throw new ArgumentException("PID is not a selectable source");
  }
  public Dictionary<string,object> Resolve(Dictionary<string,object>[] samples){
   foreach(var sample in samples)if(Convert.ToInt32(sample["pid"])==SelectedPid)return sample;
   return null;
  }
  public void Dispose(){choices.SelectionChanged-=Changed;}
 }
}
