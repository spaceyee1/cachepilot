// Candidate-only startup configuration export. No runtime activation or Python execution.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace CachePilotMonitor {
 public sealed class GpuSettingsSnapshot {
  readonly Dictionary<string,object> settings;
  public bool Enabled {get{return Device=="cuda";}}
  public string Device {get;private set;}
  public string PythonPath {get;private set;}
  public string ModelPath {get;private set;}
  public string Revision {get;private set;}
  public Dictionary<string,object> Settings {get{return MonitorProfileSchema.Clone(settings);}}
  internal GpuSettingsSnapshot(Dictionary<string,object> value,string revision){settings=MonitorProfileSchema.Clone(value);Device=value.ContainsKey("device")?(string)value["device"]:"off";PythonPath=value.ContainsKey("python")?(string)value["python"]:"";ModelPath=value.ContainsKey("modelPath")?(string)value["modelPath"]??"":"";Revision=revision;}
 }

 public sealed class GpuSettingsStore {
  const int MaximumBytes=65536;
  public const string PendingActivationText="已保存配置；待宿主接入 CACHEPILOT_PLUGIN_CONFIG 并重载，当前插件未切换";
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly SecurityIdentifier User=WindowsIdentity.GetCurrent().User;
  static readonly SecurityIdentifier SystemUser=new SecurityIdentifier("S-1-5-18");
  readonly string root,directory,config,lockPath;
  readonly string[] ownedDirectories;
  public string StorageMode {get;private set;}
  public string ProfileId {get;private set;}
  public string ConfigPath { get {return config;} }
  // The one-argument constructor is explicitly portable; production calls Create.
  public GpuSettingsStore(string appRoot):this(appRoot,"portable","default",null){}
  public static GpuSettingsStore Create(string appRoot,string storageMode,string profileId){return new GpuSettingsStore(appRoot,storageMode,profileId,null);}
  internal static GpuSettingsStore CreateForTest(string appRoot,string storageMode,string profileId,string userDataRoot){Require(!String.IsNullOrEmpty(userDataRoot));return new GpuSettingsStore(appRoot,storageMode,profileId,userDataRoot);}
  GpuSettingsStore(string appRoot,string storageMode,string profileId,string userDataRoot) {
   try {
    Require(storageMode=="user"||storageMode=="portable");
    Require(Regex.IsMatch(profileId??"",@"\A[a-z0-9][a-z0-9_-]{0,63}\z")&&!Regex.IsMatch(profileId,@"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\z",RegexOptions.IgnoreCase));
    StorageMode=storageMode;ProfileId=profileId;
    root=LocalPath(storageMode=="portable"?appRoot:(userDataRoot??Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)),true,false);
    string first=Path.Combine(root,storageMode=="portable"?"data":"CachePilot");string profiles=Path.Combine(first,"profiles");directory=Path.Combine(profiles,profileId);
    ownedDirectories=new[]{first,profiles,directory};LocalPath(directory,true,true,true);
    config=Path.Combine(directory,"plugin-settings.json");lockPath=Path.Combine(directory,"plugin-settings.lock");
   } catch {throw Rejected();}
  }
  static InvalidOperationException Rejected() {return new InvalidOperationException("GPU_SETTINGS_REJECTED");}
  static void Require(bool value) {if(!value)throw Rejected();}
  static string Digest(byte[] bytes) {
   using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
  }
  // Absolute drive paths only; inspect each ancestor before traversing further.
  static string LocalPath(string value,bool directoryExpected,bool allowMissingLeaf,bool allowMissingDescendants=false) {
   Require(value!=null && value.Length>0 && value.Length<=4096 && Regex.IsMatch(value,@"^[A-Za-z]:\\")
    && !Regex.IsMatch(value,@"[\x00-\x1f\x7f/<>""|?*]") && value.IndexOf(':',2)<0);
   string full=Path.GetFullPath(value);
   Require(String.Equals(full.TrimEnd('\\'),value.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase));
   string cursor=Path.GetPathRoot(full);
   Require(Directory.Exists(cursor) && (File.GetAttributes(cursor)&FileAttributes.ReparsePoint)==0);
   string remaining=full.Substring(cursor.Length).TrimEnd('\\');
   string[] parts=remaining.Length==0?new string[0]:remaining.Split('\\');
   for(int i=0;i<parts.Length;i++) {
    string part=parts[i];
    Require(part.Length>0 && part!="." && part!=".." && !part.EndsWith(".") && !part.EndsWith(" ")
     && !Regex.IsMatch(part,@"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",RegexOptions.IgnoreCase));
    cursor=Path.Combine(cursor,part);
    bool exists=File.Exists(cursor)||Directory.Exists(cursor);
    if(!exists) {Require(allowMissingDescendants || (allowMissingLeaf && i==parts.Length-1));continue;}
    FileAttributes attributes=File.GetAttributes(cursor);
    Require((attributes&FileAttributes.ReparsePoint)==0);
    bool shouldBeDirectory=i<parts.Length-1||directoryExpected;
    Require(((attributes&FileAttributes.Directory)!=0)==shouldBeDirectory);
   }
   Require(parts.Length>0 || directoryExpected);
   return full.TrimEnd('\\');
  }
  static FileSecurity PrivateFile() {
   var value=new FileSecurity();value.SetOwner(User);value.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{User,SystemUser})value.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
   return value;
  }
  static DirectorySecurity PrivateDirectory() {
   var value=new DirectorySecurity();value.SetOwner(User);value.SetAccessRuleProtection(true,false);
   foreach(var sid in new[]{User,SystemUser})value.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
   return value;
  }
  static void AssertPrivate(string path,bool isDirectory) {
   LocalPath(path,isDirectory,false);
   FileSystemSecurity security=isDirectory?(FileSystemSecurity)Directory.GetAccessControl(path):File.GetAccessControl(path);
   Require(security.AreAccessRulesProtected && security.GetOwner(typeof(SecurityIdentifier)).Equals(User));
   bool user=false,system=false;
   foreach(FileSystemAccessRule rule in security.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
    Require(rule.AccessControlType==AccessControlType.Allow && (rule.IdentityReference.Equals(User)||rule.IdentityReference.Equals(SystemUser))
     && (rule.FileSystemRights&FileSystemRights.FullControl)==FileSystemRights.FullControl && !rule.IsInherited);
    if(rule.IdentityReference.Equals(User))user=true;
    if(rule.IdentityReference.Equals(SystemUser))system=true;
   }
   Require(user && system);
  }
  static void ValidateEnabledPaths(string python,string model,bool requireExists=true) {
   string executable=LocalPath(python,false,!requireExists,!requireExists);
   Require(Regex.IsMatch(Path.GetFileName(executable),@"^python(?:\d+(?:\.\d+)*)?\.exe$",RegexOptions.IgnoreCase));
   LocalPath(model,true,!requireExists,!requireExists);
  }
  void InspectDirectory(bool create) {
   LocalPath(root,true,false);
   foreach(string folder in ownedDirectories){LocalPath(folder,true,true);if(!Directory.Exists(folder)){Require(create);Directory.CreateDirectory(folder,PrivateDirectory());}AssertPrivate(folder,true);}
  }
  GpuSettingsSnapshot ReadExisting() {
   AssertPrivate(config,false);byte[] bytes;
   using(var file=new FileStream(config,FileMode.Open,FileAccess.Read,FileShare.Read)) {
    Require(file.Length>0&&file.Length<=MaximumBytes);bytes=new byte[(int)file.Length];
    int offset=0,count;while(offset<bytes.Length&&(count=file.Read(bytes,offset,bytes.Length-offset))>0)offset+=count;
    Require(offset==bytes.Length&&file.ReadByte()==-1);AssertPrivate(config,false);
   }
   var value=MonitorProfileSchema.Parse(bytes);
   return new GpuSettingsSnapshot(value,Digest(bytes));
  }
  public GpuSettingsSnapshot Load() {
   try {
    LocalPath(root,true,false);LocalPath(directory,true,true,true);
    if(!Directory.Exists(directory))return new GpuSettingsSnapshot(MonitorProfileSchema.Defaults(),"missing");
    InspectDirectory(false);LocalPath(config,false,true);
    return File.Exists(config)?ReadExisting():new GpuSettingsSnapshot(MonitorProfileSchema.Defaults(),"missing");
   } catch {throw Rejected();}
  }
  public GpuSettingsSnapshot Save(bool enabled,string pythonPath,string modelPath,string expectedRevision) {
   string temporary=null;
   try {
    Require(expectedRevision!=null&&(expectedRevision=="missing"||Regex.IsMatch(expectedRevision,"^[a-f0-9]{64}$")));
    if(enabled)ValidateEnabledPaths(pythonPath,modelPath);
    InspectDirectory(true);LocalPath(lockPath,false,true);
    if(File.Exists(lockPath))AssertPrivate(lockPath,false);
    using(var gate=new FileStream(lockPath,FileMode.OpenOrCreate,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.None,PrivateFile())) {
     AssertPrivate(lockPath,false);var existing=Load();
     if(!String.Equals(existing.Revision,expectedRevision,StringComparison.Ordinal))throw new InvalidOperationException("GPU_SETTINGS_CONFLICT");
     var value=existing.Settings;value["device"]=enabled?"cuda":"off";
     if(enabled){value["python"]=pythonPath;value["modelPath"]=modelPath;}
     byte[] bytes=MonitorProfileSchema.Serialize(value);Require(bytes.Length<=MaximumBytes);
     temporary=Path.Combine(directory,"gpu-plugin-config."+Guid.NewGuid().ToString("N")+".tmp");
     using(var file=new FileStream(temporary,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.WriteThrough,PrivateFile())) {
      file.Write(bytes,0,bytes.Length);file.Flush(true);
     }
     AssertPrivate(temporary,false);InspectDirectory(false);
     Require(Load().Revision==expectedRevision);
     if(File.Exists(config))File.Replace(temporary,config,null);else File.Move(temporary,config);
     temporary=null;AssertPrivate(config,false);
     return ReadExisting();
    }
   } catch(InvalidOperationException error) {
    if(error.Message=="GPU_SETTINGS_CONFLICT")throw;throw Rejected();
   } catch {throw Rejected();}
   finally {
    if(temporary!=null)try{InspectDirectory(false);AssertPrivate(temporary,false);File.Delete(temporary);}catch{}
   }
  }
 }
}
