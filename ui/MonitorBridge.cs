// Original CachePilot UI bridge. Framework/Win32 APIs only; no external packages.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace CachePilotMonitor {
 public sealed class Bridge : IDisposable {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  public static void ShowOverlay(IntPtr window) { ShowWindow(window, 5); }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string value, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes security);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
  readonly object gate = new object();
  // Diagnostic fields contain receiver identities and timing only. No publisher
  // JSON, exception messages, paths, text, credentials, or pipe names are retained.
  // Recording is observational and cannot throw into a transport control path.
  readonly MonitorDiagnostics diagnostics = new MonitorDiagnostics("bridge");
  readonly Stopwatch diagnosticClock = Stopwatch.StartNew();
  public enum DiagnosticPhase { None=0, Waiting=1, PeerIdentity=2, Deadline=3, Reserve=4, Read=5, MarkBytes=6, ReserveRead=7, Validate=8, Parse=9, Commit=10, Reject=11, End=12, Reopen=13, Loop=14, Dispose=15 }
  public enum DiagnosticError { None=0, Cancelled=1, Io=2, Disposed=3, InvalidUtf8=4, Argument=5, InvalidOperation=6, Overflow=7, Format=8, Unauthorized=9, Security=10, Unsupported=11, Other=255 }
  sealed class ConnectionDiagnostic {
   internal uint Pid;
   internal ReceiverTicket First,Read;
   internal DiagnosticPhase Phase;
   internal long AcceptedUtc,AcceptedMono,DeadlineUtc,DeadlineMono;
   internal int Bytes,ReadCalls,DeadlineScheduled,DeadlineFired,DeadlineWasTimeout,PeerWin32Error,FrameParsed,CommitAttempted,CommitAccepted,Normal,PipeReused;
  }
  static DiagnosticError Classify(Exception error) {
   if(error==null)return DiagnosticError.None;
   if(error is OperationCanceledException)return DiagnosticError.Cancelled;
   if(error is ObjectDisposedException)return DiagnosticError.Disposed;
   if(error is DecoderFallbackException)return DiagnosticError.InvalidUtf8;
   if(error is OverflowException)return DiagnosticError.Overflow;
   if(error is UnauthorizedAccessException)return DiagnosticError.Unauthorized;
   if(error is System.Security.SecurityException)return DiagnosticError.Security;
   if(error is NotSupportedException)return DiagnosticError.Unsupported;
   if(error is ArgumentException)return DiagnosticError.Argument;
   if(error is InvalidOperationException)return DiagnosticError.InvalidOperation;
   if(error is FormatException)return DiagnosticError.Format;
   if(error is IOException)return DiagnosticError.Io;
   return DiagnosticError.Other;
  }
  void Record(string code,ConnectionDiagnostic value,Exception error) {
   try {
    var ticket=value==null?null:value.First;
    var read=value==null?null:value.Read;
    diagnostics.Record(code,code=="bridge-reject-requested"||code=="bridge-reject-returned"?"invalid-transport-or-frame":"transport-observation",new Dictionary<string,object>{
     {"originCode",2},{"monoMs",diagnosticClock.ElapsedMilliseconds},{"running",Running},{"stopRequested",stop.IsCancellationRequested},
     {"phaseCode",value==null?0:(int)value.Phase},{"errorCode",(int)Classify(error)},{"errorHResult",error==null?0:error.HResult},{"peerWin32Error",value==null?0:value.PeerWin32Error},
     {"osPid",value==null?0L:(long)value.Pid},{"acceptedUtcMs",value==null?0:value.AcceptedUtc},{"acceptedMonoMs",value==null?0:value.AcceptedMono},
     {"originSeq",ticket==null?0:ticket.OriginSeq},{"readOriginSeq",read==null?0:read.OriginSeq},{"transportId",ticket==null?0:ticket.TransportConnectionId},
     {"sourceSessionGeneration",ticket==null?0:ticket.SourceSessionGeneration},{"processIdentity",ticket==null?0:ticket.ProcessIdentity},
     {"reservedMonoMs",ticket==null?0:ticket.ReservedMonotonicMilliseconds},{"receiptMonoMs",ticket==null||!ticket.ReceiptMono.HasValue?-1:ticket.ReceiptMono.Value},
     {"receiptUtcMs",ticket==null||!ticket.ReceiptUtc.HasValue?-1:ticket.ReceiptUtc.Value},
     {"readReceiptMonoMs",read==null||!read.ReceiptMono.HasValue?-1:read.ReceiptMono.Value},
     {"bytesRead",value==null?0:value.Bytes},{"readCalls",value==null?0:value.ReadCalls},{"readDeadlineMs",500},
     {"readDeadlineScheduled",value!=null&&value.DeadlineScheduled!=0},{"deadlineCallbackFired",value!=null&&value.DeadlineFired!=0},
     {"deadlineWasTimeout",value!=null&&value.DeadlineWasTimeout!=0},{"deadlineCallbackUtcMs",value==null?0:value.DeadlineUtc},{"deadlineCallbackMonoMs",value==null?0:value.DeadlineMono},
     {"frameParsed",value!=null&&value.FrameParsed!=0},{"commitAttempted",value!=null&&value.CommitAttempted!=0},
     {"commitAccepted",value!=null&&value.CommitAccepted!=0},{"normalEnd",value!=null&&value.Normal!=0},{"pipeReused",value!=null&&value.PipeReused!=0},{"rejectedCount",Rejected}
    });
   } catch { diagnostics.NoteFailure(); /* Diagnostics must not change transport behavior. */ }
  }
  public Dictionary<string,object>[] DrainDiagnostics() { return diagnostics.Drain(); }
  public long DiagnosticDroppedCount { get { return diagnostics.DroppedCount; } }
  public long DiagnosticFailureCount { get { return diagnostics.FailureCount; } }
  public MonitorReceiver Receiver { get; private set; }
  readonly CancellationTokenSource stop = new CancellationTokenSource();
  NamedPipeServerStream current;
  Task pump;
  public string PipeName { get; private set; }
  public bool Running { get; private set; }
  public string LastFailure { get; private set; }
  public int Rejected { get; private set; }
  public Bridge() : this(null) {}
  public Bridge(string pipeName) {
   Receiver = new MonitorReceiver();
   if(pipeName!=null) {
    if(!Regex.IsMatch(pipeName,@"^cachepilot-test-[a-fA-F0-9-]{16,64}$"))throw new ArgumentException("An isolated validation pipe name is required");
    PipeName=pipeName;return;
   }
   string profile = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)).TrimEnd('\\').ToLowerInvariant();
   using (var hash = SHA256.Create()) PipeName = "cachepilot-monitor-v1-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(profile))).Replace("-", "").ToLowerInvariant().Substring(0,20);
  }
  NamedPipeServerStream Open() {
   IntPtr descriptor;
   uint size;
   string sid = WindowsIdentity.GetCurrent().User.Value;
   if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out descriptor, out size)) throw new IOException("Monitor ACL failed");
   try {
    var security = new SecurityAttributes {length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor,inherit=0};
    // First-instance ownership, overlapped input, and explicit remote-client rejection.
    var handle = CreateNamedPipe("\\\\.\\pipe\\" + PipeName, 0x40080001, 8, 1, 0, 4096, 500, ref security);
    if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Monitor already open or unavailable"); }
    try { return new NamedPipeServerStream(PipeDirection.In, true, false, handle); }
    catch { handle.Dispose(); throw; }
   } finally { LocalFree(descriptor); }
  }
  public void Start() {
   if (pump != null) return;
   current = Open(); // Fail synchronously if another overlay owns this user's pipe.
   Running = true;
   Record("bridge-started",null,null);
   pump = Task.Run((Action)Run);
  }
  void Run() {
   ConnectionDiagnostic loopDiagnostic=null;
   try {
    while (!stop.IsCancellationRequested) {
     NamedPipeServerStream pipe;
     lock (gate) pipe = current;
     uint actualPid=0;ReceiverTicket first=null;bool normal=false;
     var diagnostic=new ConnectionDiagnostic{Phase=DiagnosticPhase.Waiting};
     loopDiagnostic=diagnostic;
     Record("bridge-wait",diagnostic,null);
     try {
      pipe.WaitForConnectionAsync(stop.Token).GetAwaiter().GetResult();
      diagnostic.AcceptedUtc=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();diagnostic.AcceptedMono=diagnosticClock.ElapsedMilliseconds;
      diagnostic.Phase=DiagnosticPhase.PeerIdentity;Record("bridge-accepted",diagnostic,null);
      if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out actualPid)) { diagnostic.PeerWin32Error=Marshal.GetLastWin32Error();throw new IOException(); }
      diagnostic.Pid=actualPid;Record("bridge-peer-identified",diagnostic,null);
      using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop.Token)) {
       diagnostic.Phase=DiagnosticPhase.Deadline;
       deadline.CancelAfter(500);
       diagnostic.DeadlineScheduled=1;
       using (deadline.Token.Register(() => { Interlocked.Exchange(ref diagnostic.DeadlineFired,1);if(!stop.IsCancellationRequested)Interlocked.Exchange(ref diagnostic.DeadlineWasTimeout,1);diagnostic.DeadlineUtc=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();diagnostic.DeadlineMono=diagnosticClock.ElapsedMilliseconds;try { pipe.Dispose(); } catch {} Record("bridge-deadline-callback",diagnostic,null); })) {
        byte[] buffer = new byte[4096]; int used = 0;
        // Reserve while holding the same gate as a UI selection boundary,
        // before the raw read starts. A delayed read cannot get a new origin.
        diagnostic.Phase=DiagnosticPhase.Reserve;
        first=Receiver.Reserve(checked((int)actualPid));diagnostic.First=first;diagnostic.Read=first;
        Record("bridge-reserved",diagnostic,null);
        ReceiverTicket read=first;
        while (used < buffer.Length) {
         diagnostic.Phase=DiagnosticPhase.Read;diagnostic.ReadCalls++;Record("bridge-read-begin",diagnostic,null);
         int n = pipe.ReadAsync(buffer, used, buffer.Length-used, deadline.Token).GetAwaiter().GetResult();
         diagnostic.Bytes+=n;Record("bridge-read-complete",diagnostic,null);
         if (n == 0) break;
         diagnostic.Phase=DiagnosticPhase.MarkBytes;
         if(!Receiver.MarkBytes(read))throw new IOException("Transport revoked");
         Record("bridge-bytes-marked",diagnostic,null);
         used += n;
         if (Array.IndexOf(buffer, (byte)10, 0, used) >= 0) break;
         diagnostic.Phase=DiagnosticPhase.ReserveRead;
         read=Receiver.ReserveRead(first);diagnostic.Read=read;Record("bridge-read-reserved",diagnostic,null);
        }
        diagnostic.Phase=DiagnosticPhase.Validate;
        if (used == 0 || used >= buffer.Length || buffer[used-1] != 10) throw new IOException();
        diagnostic.Phase=DiagnosticPhase.Parse;
        var frame=FrameCodec.Parse(new UTF8Encoding(false,true).GetString(buffer,0,used),actualPid,DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        diagnostic.FrameParsed=1;Record("bridge-frame-parsed",diagnostic,null);
        diagnostic.Phase=DiagnosticPhase.Commit;diagnostic.CommitAttempted=1;
        bool committed=Receiver.Commit(first,frame,0);if(!committed)Rejected++;normal=true;
        diagnostic.CommitAccepted=committed?1:0;diagnostic.Normal=1;Record("bridge-commit-complete",diagnostic,null);
       }
      }
     } catch(Exception error) { Record("bridge-connection-error",diagnostic,error);if (!stop.IsCancellationRequested) { Rejected++;if(first!=null){diagnostic.Phase=DiagnosticPhase.Reject;Record("bridge-reject-requested",diagnostic,null);Receiver.Reject(first,"invalid-transport-or-frame");Record("bridge-reject-returned",diagnostic,null);} } }
     finally { diagnostic.Phase=DiagnosticPhase.End;diagnostic.Normal=normal?1:0;Record("bridge-end-begin",diagnostic,null);if(first!=null)Receiver.EndTransport(first,normal);if(!normal)pipe.Dispose();Record("bridge-end-complete",diagnostic,null); }
     diagnostic.Phase=DiagnosticPhase.Reopen;Record("bridge-rearm-begin",diagnostic,null);
     lock (gate) {
      // This point is after the old deadline registration/CTS have disposed.
      // Retain FIRST-instance ownership on normal frames: removing the named
      // pipe between every frame made simultaneous native clients see ENOENT.
      // Shutdown and rearming use the same gate, so no listener opens after stop.
      if(stop.IsCancellationRequested){pipe.Dispose();break;}
      if(normal){
       try{pipe.Disconnect();diagnostic.PipeReused=1;}
       catch(Exception error){
        if(!(error is IOException)&&!(error is ObjectDisposedException)&&!(error is InvalidOperationException))throw;
        Record("bridge-rearm-fallback",diagnostic,error);pipe.Dispose();current=Open();
       }
      }else current=Open();
     }
     Record("bridge-rearm-complete",diagnostic,null);
    }
   } catch(Exception error) { LastFailure=error.GetType().Name;Record("bridge-loop-failure",loopDiagnostic,error); } finally { Running = false;Record("bridge-stopped",loopDiagnostic,null);Receiver.InvalidateSelected("channel-stopped");Record("bridge-channel-invalidated",loopDiagnostic,null); }
  }
  public Dictionary<string,object>[] GetSamples() {
   return Receiver.GetSamples();
  }
  public string Snapshot() { return new JavaScriptSerializer().Serialize(GetSamples()); }
  public void Dispose() {
   Record("bridge-dispose-begin",null,null);
   stop.Cancel();
   lock(gate) { if(current!=null) current.Dispose(); }
   if(pump!=null) { try { pump.Wait(1500); } catch {} }
   Running=false;Receiver.InvalidateSelected("closed");
   Record("bridge-dispose-complete",null,null);
  }
 }
}
