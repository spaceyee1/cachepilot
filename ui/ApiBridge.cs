using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace CachePilotMonitor {
 // A separate SID-restricted telemetry pipe. No HTTP listener or credentials.
 public sealed class ApiBridge : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {public int length;public IntPtr descriptor;public int inherit;}
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value,uint revision,out IntPtr descriptor,out uint size);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint pipeMode,uint instances,uint outSize,uint inSize,uint timeout,ref SecurityAttributes security);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
  readonly object gate=new object();readonly CancellationTokenSource stop=new CancellationTokenSource();NamedPipeServerStream current;Task pump;
  public readonly ApiReceiver Receiver;public readonly string PipeName;public bool Running {get;private set;}public int Rejected {get;private set;}public string LastFailure {get;private set;}
  public ApiBridge():this(null,false){}
  public ApiBridge(string testPipe,bool allowFixtures){
   if(testPipe!=null&&!Regex.IsMatch(testPipe,@"\Acachepilot-api-test-[a-f0-9]{32}\z"))throw new ArgumentException("Isolated test pipe required");
   Receiver=allowFixtures?new ApiReceiver(()=>clock.ElapsedMilliseconds,Identity,true):new ApiReceiver();
   if(testPipe!=null){PipeName=testPipe;return;}
   if(allowFixtures)throw new ArgumentException("Fixtures require an isolated pipe");
   string profile=Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).TrimEnd('\\').ToLowerInvariant();
   using(var hash=SHA256.Create())PipeName="cachepilot-api-monitor-v1-"+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(profile))).Replace("-","").ToLowerInvariant().Substring(0,20);
  }
  readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
  static long? Identity(int pid){try{using(var p=System.Diagnostics.Process.GetProcessById(pid))return p.HasExited?(long?)null:p.StartTime.ToUniversalTime().Ticks;}catch{return null;}}
  NamedPipeServerStream Open(){IntPtr descriptor;uint size;string sid=WindowsIdentity.GetCurrent().User.Value;
   if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")",1,out descriptor,out size))throw new IOException("API monitor ACL failed");
   try{var security=new SecurityAttributes{length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor,inherit=0};
    // FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED | PIPE_ACCESS_INBOUND;
    // PIPE_REJECT_REMOTE_CLIENTS and exactly one instance.
    var handle=CreateNamedPipe("\\\\.\\pipe\\"+PipeName,0x40080001,8,1,0,16384,500,ref security);
    if(handle.IsInvalid){handle.Dispose();throw new IOException("API monitor is already open or unavailable");}
    try{return new NamedPipeServerStream(PipeDirection.In,true,false,handle);}catch{handle.Dispose();throw;}
   }finally{LocalFree(descriptor);}
  }
  public void Start(){if(pump!=null)return;current=Open();Running=true;pump=Task.Run((Action)Run);}
  void Run(){try{while(!stop.IsCancellationRequested){NamedPipeServerStream pipe;lock(gate)pipe=current;ApiTicket ticket=null;string phase="connect";
    try{pipe.WaitForConnectionAsync(stop.Token).GetAwaiter().GetResult();phase="authenticate";uint pid;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)||pid>Int32.MaxValue)throw new IOException("Cannot authenticate telemetry process");ticket=Receiver.Reserve((int)pid);
     using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(stop.Token)){deadline.CancelAfter(500);using(deadline.Token.Register(()=>{try{pipe.Dispose();}catch{}})){
      phase="read";byte[] buffer=new byte[16385];int used=0;
      while(used<buffer.Length){int read=pipe.ReadAsync(buffer,used,buffer.Length-used,deadline.Token).GetAwaiter().GetResult();if(read==0)break;Receiver.MarkBytes(ticket);used+=read;if(Array.IndexOf(buffer,(byte)10,0,used)>=0)break;}
      phase="frame-boundary";if(used==0||used>16384||buffer[used-1]!=10||Array.IndexOf(buffer,(byte)10,0,used)!=used-1)throw new IOException("Exactly one bounded telemetry frame required");
      var frame=ApiCodec.Parse(new UTF8Encoding(false,true).GetString(buffer,0,used),pid,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());if(!Receiver.Commit(ticket,frame)){Rejected++;LastFailure="FrameRejected";}
     }}
    }catch(Exception error){if(!stop.IsCancellationRequested){Rejected++;LastFailure=phase+":"+error.GetType().Name;Receiver.Reject(ticket);}}
    finally{pipe.Dispose();}
    if(!stop.IsCancellationRequested)lock(gate)current=Open();
   }}catch(Exception error){LastFailure=error.GetType().Name;Running=false;}finally{Running=false;}}
  public void Dispose(){stop.Cancel();lock(gate){if(current!=null)try{current.Dispose();}catch{}}if(pump!=null)try{pump.Wait(1500);}catch{}Running=false;}
 }
}
