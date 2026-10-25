using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using System.Windows.Markup;
using Microsoft.Win32.SafeHandles;

namespace CachePilotMonitor {
 internal sealed class MonitorXamlIntegrityException:Exception {
  internal MonitorXamlIntegrityException():base("XAML_INTEGRITY_REJECTED"){}
 }
 // The expected bytes are a build input embedded in this EXE, never a mutable
 // sibling manifest. This protects external XAML, not a replaceable EXE/build.
 internal static class MonitorXamlLoader {
  const string ResourceName="CachePilotMonitor.TrustedMonitorXaml";
  const int MaximumBytes=65536;
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
   internal uint Attributes;
   internal System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
   internal uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
  static void Reject(){throw new MonitorXamlIntegrityException();}
  static byte[] Bounded(Stream stream){
   using(var memory=new MemoryStream()){
    var buffer=new byte[4096];int count;
    while((count=stream.Read(buffer,0,Math.Min(buffer.Length,MaximumBytes+1-(int)memory.Length)))>0){
     memory.Write(buffer,0,count);if(memory.Length>MaximumBytes)Reject();
    }
    if(memory.Length==0)Reject();return memory.ToArray();
   }
  }
  static string LocalPath(string path){
   if(String.IsNullOrEmpty(path)||!Path.IsPathRooted(path)||path.StartsWith(@"\\")||path.StartsWith("//")||path.IndexOf('\0')>=0)Reject();
   string full=Path.GetFullPath(path);
   if(full.Length>4096||full.Length<3||full[1]!=':'||full.Substring(2).Contains(":"))Reject();
   return full;
  }
  static void CheckPath(string full){
   for(string cursor=full;cursor!=null;cursor=Path.GetDirectoryName(cursor)){
    var attributes=File.GetAttributes(cursor);
    if((attributes&FileAttributes.ReparsePoint)!=0)Reject();
    if(cursor!=full&&(attributes&FileAttributes.Directory)==0)Reject();
   }
  }
  static void CheckHandle(SafeFileHandle handle,string full){
   FileInfo info;
   if(GetFileType(handle)!=1||!GetFileInformationByHandle(handle,out info)||(info.Attributes&(uint)(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0||info.SizeHigh!=0||info.SizeLow>MaximumBytes)Reject();
   var buffer=new StringBuilder(8192);
   uint length=GetFinalPathNameByHandle(handle,buffer,(uint)buffer.Capacity,0);
   if(length==0||length>=buffer.Capacity)Reject();
   string final=buffer.ToString();
   if(final.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase))Reject();
   if(final.StartsWith(@"\\?\",StringComparison.Ordinal))final=final.Substring(4);
   if(!String.Equals(Path.GetFullPath(final),full,StringComparison.OrdinalIgnoreCase))Reject();
  }
  internal static string ReadVerifiedText(string path){
   try {
    string full=LocalPath(path);CheckPath(full);
    byte[] expected;
    using(var resource=typeof(MonitorXamlLoader).Assembly.GetManifestResourceStream(ResourceName)){
     if(resource==null)throw new MonitorXamlIntegrityException();expected=Bounded(resource);
    }
    byte[] actual;
    // OPEN_REPARSE_POINT rejects a final symlink by handle; no write/delete
    // sharing. Final path and ancestor checks also reject redirected parents.
    using(var handle=CreateFile(full,0x80000000,1,IntPtr.Zero,3,0x08200080,IntPtr.Zero)){
     if(handle.IsInvalid)Reject();CheckHandle(handle,full);
     using(var stream=new FileStream(handle,FileAccess.Read,4096,false))actual=Bounded(stream);
    }
    CheckPath(full);
    if(actual.Length!=expected.Length)Reject();
    using(var hash=SHA256.Create()){
     byte[] a=hash.ComputeHash(actual),b=hash.ComputeHash(expected);int mismatch=0;
     for(int i=0;i<a.Length;i++)mismatch|=a[i]^b[i];if(mismatch!=0)Reject();
    }
    int skip=actual.Length>=3&&actual[0]==0xef&&actual[1]==0xbb&&actual[2]==0xbf?3:0;
    // Only these verified in-memory bytes reach the parser; never reopen path.
    return new UTF8Encoding(false,true).GetString(actual,skip,actual.Length-skip);
   }catch(MonitorXamlIntegrityException){throw;}catch{throw new MonitorXamlIntegrityException();}
  }
  internal static Window LoadWindow(string path){
   try{var window=XamlReader.Parse(ReadVerifiedText(path)) as Window;if(window==null)Reject();return window;}
   catch(MonitorXamlIntegrityException){throw;}catch{throw new MonitorXamlIntegrityException();}
  }
  internal static Window LoadOwnWindow(){return LoadWindow(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Monitor.xaml"));}
 }
}
