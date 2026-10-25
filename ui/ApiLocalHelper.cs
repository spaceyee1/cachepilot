// Original local helper. No HTTP client, shell execution, key logging, or GPU use.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ApiLocalHelper {
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly string[] Protocols = { "openai-responses", "openai-chat", "deepseek-chat", "anthropic-messages", "gemini" };
    static readonly string[] LimitNames = { "maxRequests", "maxInputBytes", "maxTotalInputBytes", "maxOutputTokens", "maxTotalOutputTokens", "timeoutMs" };
    static readonly int[] LimitMaximum = { 20, 65536, 1048576, 1024, 8192, 60000 };
    static readonly int[] LimitDefault = { 1, 32768, 65536, 128, 256, 30000 };
    static readonly SecurityIdentifier UserSid = WindowsIdentity.GetCurrent().User;
    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = 81920, RecursionLimit = 24 }; }
    static Exception Invalid() { return new InvalidOperationException("LOCAL_HELPER_REJECTED"); }
    static void Require(bool condition) { if (!condition) throw Invalid(); }
    static bool IsId(string value) { return value != null && Regex.IsMatch(value, "^[a-z0-9][a-z0-9_-]{0,47}$"); }
    static bool IsGeneration(string value) { return value != null && Regex.IsMatch(value, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.IgnoreCase); }
    static bool CleanText(string value, int maximum) { return !String.IsNullOrEmpty(value) && value.Length <= maximum && !Regex.IsMatch(value, "[\\x00-\\x1f\\x7f]"); }
    static Dictionary<string, object> ObjectValue(object value) { var result = value as Dictionary<string, object>; Require(result != null); return result; }
    static string StringValue(Dictionary<string, object> value, string name) { object result; Require(value.TryGetValue(name, out result) && result is string); return (string)result; }
    static int IntegerValue(Dictionary<string, object> value, string name) { object result; Require(value.TryGetValue(name, out result) && result is int); return (int)result; }
    static void ExactKeys(Dictionary<string, object> value, params string[] keys) { Require(value.Count == keys.Length && keys.All(value.ContainsKey)); }
    static void Output(object value) {
        byte[] bytes = Utf8.GetBytes(Serializer().Serialize(value) + "\n");
        using (Stream stream = Console.OpenStandardOutput()) { stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
    }
    static Dictionary<string, object> ReadInput(int maximum) {
        using (Stream stream = Console.OpenStandardInput())
        using (var memory = new MemoryStream()) {
            byte[] bytes = new byte[2048]; int count;
            while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) { Require(memory.Length + count <= maximum); memory.Write(bytes, 0, count); }
            Require(memory.Length > 0);
            return ObjectValue(Serializer().DeserializeObject(Utf8.GetString(memory.ToArray())));
        }
    }
    static string Hash(string text) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Utf8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
    static Uri BaseUrl(string value) {
        Require(CleanText(value, 2048) && !Regex.IsMatch(value, "[\\s\\\\?#]"));
        Uri uri; Require(Uri.TryCreate(value, UriKind.Absolute, out uri));
        Require(uri.Scheme == "https" && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0 && uri.Port == 443
            && uri.HostNameType == UriHostNameType.Dns && uri.DnsSafeHost.Contains(".") && !uri.DnsSafeHost.EndsWith(".")
            && !Regex.IsMatch(uri.DnsSafeHost, "(^|\\.)(localhost|local|internal|invalid|test|example|onion)$", RegexOptions.IgnoreCase)
            && uri.DnsSafeHost.Split('.').All(part => Regex.IsMatch(part, "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", RegexOptions.IgnoreCase)));
        return uri;
    }
    static string LocalPath(string value) {
        string full = Path.GetFullPath(value);
        Require(Regex.IsMatch(full, "^[A-Za-z]:\\\\") && !full.StartsWith("\\\\", StringComparison.Ordinal));
        string cursor = Path.GetPathRoot(full);
        foreach (string part in full.Substring(cursor.Length).Split(Path.DirectorySeparatorChar)) {
            if (part.Length == 0) continue;
            cursor = Path.Combine(cursor, part);
            if (File.Exists(cursor) || Directory.Exists(cursor)) Require((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) == 0);
        }
        return full;
    }
    static FileSecurity PrivateFileSecurity() {
        var security = new FileSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(UserSid);
        foreach (var sid in new[] { UserSid, SystemSid }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }
    static DirectorySecurity PrivateDirectorySecurity() {
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(UserSid);
        foreach (var sid in new[] { UserSid, SystemSid }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
    static void AssertPrivate(string value, bool directory) {
        string full = LocalPath(value);
        FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(full) : File.GetAccessControl(full);
        Require(security.AreAccessRulesProtected && security.GetOwner(typeof(SecurityIdentifier)).Equals(UserSid));
        bool userRead = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType != AccessControlType.Allow) continue;
            Require(rule.IdentityReference.Equals(UserSid) || rule.IdentityReference.Equals(SystemSid));
            if (rule.IdentityReference.Equals(UserSid) && (rule.FileSystemRights & FileSystemRights.ReadData) != 0) userRead = true;
        }
        Require(userRead);
    }
    static string ProfileDirectory(bool create) {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        Require(!String.IsNullOrEmpty(local)); LocalPath(local);
        string root = LocalPath(Path.Combine(local, "CachePilotApi"));
        string directory = LocalPath(Path.Combine(root, "profiles"));
        foreach (string current in new[] { root, directory }) {
            if (create && !Directory.Exists(current)) Directory.CreateDirectory(current, PrivateDirectorySecurity());
            Require(Directory.Exists(current)); AssertPrivate(current, true);
        }
        return directory;
    }
    static Dictionary<string, object> LoadProfile(string id, string generation) {
        Require(IsId(id) && IsGeneration(generation));
        string file = LocalPath(Path.Combine(ProfileDirectory(false), id + ".json"));
        AssertPrivate(file, false);
        byte[] bytes;
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            Require(stream.Length > 0 && stream.Length <= 32768);
            using (var memory = new MemoryStream()) {
                byte[] buffer = new byte[2048]; int count;
                while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) { Require(memory.Length + count <= 32768); memory.Write(buffer, 0, count); }
                bytes = memory.ToArray();
            }
        }
        var value = ObjectValue(Serializer().DeserializeObject(Utf8.GetString(bytes)));
        ExactKeys(value, "version", "id", "label", "protocol", "baseUrl", "model", "credentialGeneration", "networkEnabled", "limits", "credentialCipher");
        Require(IntegerValue(value, "version") == 1 && StringValue(value, "id") == id && StringValue(value, "credentialGeneration") == generation);
        Require(CleanText(StringValue(value, "label"), 96) && CleanText(StringValue(value, "model"), 160));
        BaseUrl(StringValue(value, "baseUrl")); Require(Protocols.Contains(StringValue(value, "protocol")) && value["networkEnabled"] is bool);
        var limits = ObjectValue(value["limits"]); ExactKeys(limits, LimitNames);
        for (int i = 0; i < LimitNames.Length; i++) { int n = IntegerValue(limits, LimitNames[i]); Require(n >= 1 && n <= LimitMaximum[i]); }
        Require(IntegerValue(limits, "maxTotalInputBytes") >= IntegerValue(limits, "maxInputBytes") && IntegerValue(limits, "maxTotalOutputTokens") >= IntegerValue(limits, "maxOutputTokens"));
        string cipher = StringValue(value, "credentialCipher"); Require(cipher.Length >= 4 && cipher.Length <= 16384);
        return value;
    }
    static void ReadCredential(string id, string generation) {
        var value = LoadProfile(id, generation);
        byte[] cipher = Convert.FromBase64String(StringValue(value, "credentialCipher")), plain = null;
        string key = null;
        try {
            plain = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser); key = Utf8.GetString(plain);
            Require(key.Length >= 8 && key.Length <= 4096 && !Regex.IsMatch(key, "[\\x00-\\x20\\x7f]"));
            var latest = LoadProfile(id, generation);
            Require(StringValue(value, "credentialCipher") == StringValue(latest, "credentialCipher"));
            Output(new { key = key, generation = generation });
        } finally { if (plain != null) Array.Clear(plain, 0, plain.Length); Array.Clear(cipher, 0, cipher.Length); key = null; }
    }
    static Form Window(string title, int width, int height) {
        return new Form { Text = title, Size = new Size(width, height), StartPosition = FormStartPosition.CenterScreen, MaximizeBox = false, MinimizeBox = false };
    }
    static Label LabelAt(Control parent, string text, int x, int y, int width, int height) {
        var label = new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height) }; parent.Controls.Add(label); return label;
    }
    static Button ButtonAt(Control parent, string text, int x, int y, int width) {
        var button = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 30) }; parent.Controls.Add(button); return button;
    }
    static void TimedDialog(Form form) {
        using (var timer = new Timer { Interval = 45000 }) {
            timer.Tick += delegate { form.DialogResult = DialogResult.Cancel; form.Close(); };
            timer.Start(); try { form.ShowDialog(); } finally { timer.Stop(); }
        }
    }
    static void Approve() {
        var value = ReadInput(81920); ExactKeys(value, "baseUrl", "bodyHash", "bodyText", "maxOutputTokens", "model", "protocol", "requestId");
        string requestId = StringValue(value, "requestId"), hash = StringValue(value, "bodyHash"), bodyText = StringValue(value, "bodyText");
        string model = StringValue(value, "model"), protocol = StringValue(value, "protocol"); int tokens = IntegerValue(value, "maxOutputTokens");
        Require(IsGeneration(requestId) && Regex.IsMatch(hash, "^[0-9a-f]{64}$") && Utf8.GetByteCount(bodyText) <= 65536 && Hash(bodyText) == hash);
        Require(CleanText(model, 160) && Protocols.Contains(protocol) && tokens >= 1 && tokens <= 1024); Uri uri = BaseUrl(StringValue(value, "baseUrl"));
        ObjectValue(Serializer().DeserializeObject(bodyText));
        bool approved = false;
        using (var form = Window("CachePilot - approve one API request - GPU OFF", 850, 710)) {
            LabelAt(form, "Destination: " + uri.AbsoluteUri + "\r\nModel: " + model + "  Protocol: " + protocol + "\r\nOutput token ceiling: " + tokens + ". May incur provider charges.\r\nReview the complete native request. Default: Deny. Expires in 45 seconds.", 16, 12, 800, 88);
            var body = new TextBox { Multiline = true, ReadOnly = true, MaxLength = 81920, WordWrap = false, ScrollBars = ScrollBars.Both, Text = bodyText, Location = new Point(16, 106), Size = new Size(800, 505), Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right };
            form.Controls.Add(body);
            var allow = ButtonAt(form, "Allow this request", 502, 626, 154); allow.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            var deny = ButtonAt(form, "Deny", 670, 626, 145); deny.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; deny.DialogResult = DialogResult.Cancel;
            form.AcceptButton = deny; form.CancelButton = deny;
            allow.Click += delegate { approved = true; form.DialogResult = DialogResult.OK; form.Close(); };
            form.FormClosing += delegate { if (form.DialogResult != DialogResult.OK) approved = false; };
            try { TimedDialog(form); } finally { body.Clear(); }
        }
        Output(new { approved = approved, bodyHash = hash, requestId = requestId });
    }
    static void Gateway() {
        var value = ReadInput(8192); ExactKeys(value, "address", "expiresAt", "model", "profileId", "protocol", "token");
        string address = StringValue(value, "address"), token = StringValue(value, "token"), model = StringValue(value, "model"), profile = StringValue(value, "profileId"), protocol = StringValue(value, "protocol");
        Match match = Regex.Match(address, "^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$"); int port;
        Require(match.Success && Int32.TryParse(match.Groups[1].Value, out port) && port <= 65535 && Regex.IsMatch(token, "^[A-Za-z0-9_-]{43}$") && IsId(profile) && CleanText(model, 160) && Protocols.Contains(protocol));
        DateTimeOffset expires; Require(DateTimeOffset.TryParse(StringValue(value, "expiresAt"), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out expires) && expires > DateTimeOffset.UtcNow);
        using (var form = Window("CachePilot local gateway - GPU OFF", 760, 390)) {
            LabelAt(form, "Local address: " + address + "\r\nProfile: " + profile + "  Model: " + model + "\r\nProtocol: " + protocol + "  Expires: " + expires.ToLocalTime() + "\r\nTemporary LOCAL bearer token; this is not the provider API Key.", 18, 16, 710, 100);
            var box = new TextBox { ReadOnly = true, UseSystemPasswordChar = true, Text = token, Location = new Point(18, 130), Size = new Size(710, 28) }; form.Controls.Add(box);
            var notice = LabelAt(form, "Only 127.0.0.1 is served. Each provider request requires local approval. Opening this window sends no request. Closing it does not extend the gateway expiry. This window closes after 45 seconds.", 18, 178, 710, 72);
            var copy = ButtonAt(form, "Copy LOCAL token", 425, 274, 150); copy.Click += delegate { try { Clipboard.SetText(box.Text); } catch { notice.Text = "Clipboard unavailable. No credential was logged."; } };
            var close = ButtonAt(form, "Close", 590, 274, 138); close.DialogResult = DialogResult.Cancel; form.AcceptButton = close; form.CancelButton = close;
            try { TimedDialog(form); } finally { box.Clear(); token = null; value["token"] = null; }
        }
        Output(new { shown = true });
    }
    static void SaveBinding(Dictionary<string, TextBox> fields, ComboBox protocol, Dictionary<string, NumericUpDown> controls, CheckBox network, out string id, out string generation) {
        id = fields["id"].Text; Require(IsId(id) && CleanText(fields["label"].Text, 96) && CleanText(fields["model"].Text, 160));
        BaseUrl(fields["baseUrl"].Text); string key = fields["key"].Text;
        Require(key.Length >= 8 && key.Length <= 4096 && !Regex.IsMatch(key, "[\\x00-\\x20\\x7f]")); Require(Protocols.Contains((string)protocol.SelectedItem));
        var limits = new Dictionary<string, object>();
        foreach (string name in LimitNames) limits[name] = Decimal.ToInt32(controls[name].Value);
        Require((int)limits["maxTotalInputBytes"] >= (int)limits["maxInputBytes"] && (int)limits["maxTotalOutputTokens"] >= (int)limits["maxOutputTokens"]);
        string directory = ProfileDirectory(true), target = LocalPath(Path.Combine(directory, id + ".json")), temporary = null;
        if (File.Exists(target)) AssertPrivate(target, false);
        byte[] plain = null, cipher = null;
        try {
            plain = Utf8.GetBytes(key); cipher = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser); generation = Guid.NewGuid().ToString();
            var value = new Dictionary<string, object> { { "version", 1 }, { "id", id }, { "label", fields["label"].Text }, { "protocol", (string)protocol.SelectedItem }, { "baseUrl", fields["baseUrl"].Text }, { "model", fields["model"].Text }, { "credentialGeneration", generation }, { "networkEnabled", network.Checked }, { "limits", limits }, { "credentialCipher", Convert.ToBase64String(cipher) } };
            byte[] bytes = Utf8.GetBytes(Serializer().Serialize(value)); Require(bytes.Length <= 32768);
            temporary = LocalPath(Path.Combine(directory, ".bind-" + Guid.NewGuid().ToString("N") + ".tmp"));
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, PrivateFileSecurity())) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            AssertPrivate(temporary, false); AssertPrivate(directory, true); LocalPath(target);
            if (File.Exists(target)) { AssertPrivate(target, false); File.Replace(temporary, target, null); } else File.Move(temporary, target);
            temporary = null; AssertPrivate(target, false);
        } finally {
            if (plain != null) Array.Clear(plain, 0, plain.Length); if (cipher != null) Array.Clear(cipher, 0, cipher.Length); key = null;
            if (temporary != null && File.Exists(temporary)) { LocalPath(temporary); AssertPrivate(temporary, false); File.Delete(temporary); }
        }
    }
    // Pure UI construction only: no profile IO, credential access, approval or requests.
    internal sealed class BindingFormView {
        internal Form Form;
        internal Dictionary<string, TextBox> Fields;
        internal ComboBox Provider, Protocol;
        internal Dictionary<string, NumericUpDown> Limits;
        internal CheckBox Network;
        internal FlowLayoutPanel Advanced;
        internal Button ToggleAdvanced, Save, Cancel;
        internal Label Status, ProtocolSummary;
        internal bool AdvancedExpanded;
    }
    internal static BindingFormView BuildBindingForm() {
        var form = Window("CachePilot API 配置 · 简化候选 · GPU OFF", 710, 610);
        form.AutoScroll = true;
        var root = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Dock = DockStyle.Top, Padding = new Padding(16), Margin = new Padding(0) };
        form.Controls.Add(root);
        var fields = new Dictionary<string, TextBox>();
        foreach (string name in new[] { "id", "label", "baseUrl", "model", "key" }) fields[name] = new TextBox { Width = 640, MaxLength = name == "key" ? 4096 : 2048, UseSystemPasswordChar = name == "key" };
        fields["id"].Text = "api-" + Guid.NewGuid().ToString("N");
        fields["label"].Text = "API profile";
        LabelAt(root, "提供商兼容预设", 0, 0, 640, 20);
        var provider = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 640 };
        provider.Items.AddRange(new object[] { "自定义 / 兼容 API", "OpenAI-compatible Responses", "OpenAI-compatible Chat", "DeepSeek-compatible Chat", "Anthropic-compatible Messages", "Gemini-compatible" });
        provider.SelectedIndex = 0; root.Controls.Add(provider);
        LabelAt(root, "预设只选择协议。请按提供商文档填写 Base URL 和准确模型名；不猜测地址或模型。", 0, 0, 640, 36);
        foreach (var item in new[] { new[] { "baseUrl", "Base URL（HTTPS 公网地址）" }, new[] { "model", "准确模型名" }, new[] { "key", "API Key（隐藏输入；仅当前用户 DPAPI 加密保存）" } }) {
            LabelAt(root, item[1], 0, 0, 640, 20); root.Controls.Add(fields[item[0]]);
        }
        var summary = LabelAt(root, "", 0, 0, 640, 22);
        var toggle = ButtonAt(root, "高级设置 >", 0, 0, 180);
        var advanced = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, Width = 650, Margin = new Padding(0), Visible = false };
        root.Controls.Add(advanced);
        LabelAt(advanced, "配置 ID（已自动生成，可选修改）", 0, 0, 640, 20); advanced.Controls.Add(fields["id"]);
        LabelAt(advanced, "显示名称（可选）", 0, 0, 640, 20); advanced.Controls.Add(fields["label"]);
        LabelAt(advanced, "协议（兼容 / 自定义服务可手动覆盖）", 0, 0, 640, 20);
        var protocol = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Width = 640 }; protocol.Items.AddRange(Protocols); protocol.SelectedIndex = 0; advanced.Controls.Add(protocol);
        var limits = new Dictionary<string, NumericUpDown>();
        for (int i = 0; i < LimitNames.Length; i++) {
            var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Width = 640, Height = 29, Margin = new Padding(0) };
            LabelAt(row, LimitNames[i], 0, 0, 230, 22);
            var number = new NumericUpDown { Minimum = 1, Maximum = LimitMaximum[i], Value = LimitDefault[i], Width = 180 }; limits[LimitNames[i]] = number; row.Controls.Add(number); advanced.Controls.Add(row);
        }
        var network = new CheckBox { Text = "允许请求（每次仍须本地审批）", Checked = false, Width = 640, Height = 28 }; advanced.Controls.Add(network);
        var status = LabelAt(root, "默认禁止请求，保存不会联网或验证 Key。需要使用时请在高级设置中明确允许；每次请求仍须本地审批并受预算限制。", 0, 0, 640, 50);
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Width = 640, Height = 38, Margin = new Padding(0) }; root.Controls.Add(buttons);
        var cancel = ButtonAt(buttons, "取消", 0, 0, 110); cancel.DialogResult = DialogResult.Cancel;
        var save = ButtonAt(buttons, "仅本地保存", 0, 0, 115); form.CancelButton = cancel; form.AcceptButton = cancel;
        protocol.SelectedIndexChanged += delegate { summary.Text = "协议：" + (string)protocol.SelectedItem + "（可在高级设置修改）"; };
        summary.Text = "协议：" + (string)protocol.SelectedItem + "（可在高级设置修改）";
        provider.SelectedIndexChanged += delegate { int[] mapping = { 0, 0, 1, 2, 3, 4 }; if (provider.SelectedIndex >= 0 && provider.SelectedIndex < mapping.Length) protocol.SelectedIndex = mapping[provider.SelectedIndex]; };
        var view = new BindingFormView { Form = form, Fields = fields, Provider = provider, Protocol = protocol, Limits = limits, Network = network, Advanced = advanced, ToggleAdvanced = toggle, Save = save, Cancel = cancel, Status = status, ProtocolSummary = summary };
        toggle.Click += delegate { view.AdvancedExpanded = !view.AdvancedExpanded; advanced.Visible = view.AdvancedExpanded; toggle.Text = view.AdvancedExpanded ? "高级设置 <" : "高级设置 >"; };
        return view;
    }
    static void Bind() {
        object result = new { cancelled = true };
        var view = BuildBindingForm();
        using (var form = view.Form) {
            var fields = view.Fields; var protocol = view.Protocol; var limits = view.Limits; var network = view.Network; var status = view.Status;
            view.Save.Click += delegate {
                try { string id, generation; SaveBinding(fields, protocol, limits, network, out id, out generation); result = new { profileId = id, generation = generation }; fields["key"].Clear(); form.DialogResult = DialogResult.OK; form.Close(); }
                catch { status.Text = "Binding rejected. Check fields, local path, and private ACL permissions."; }
            };
            try { form.ShowDialog(); } finally { fields["key"].Clear(); }
        }
        Output(result);
    }
    static void SelfTest() {
        byte[] plain = Utf8.GetBytes("CACHEPILOT_SYNTHETIC_MARKER_NOT_A_CREDENTIAL"), cipher = null, restored = null;
        try {
            cipher = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser); restored = ProtectedData.Unprotect(cipher, null, DataProtectionScope.CurrentUser);
            Require(plain.SequenceEqual(restored) && !plain.SequenceEqual(cipher));
            Output(new { passed = true, syntheticMarker = true, realCredentialUsed = false, networkRequests = 0, configurationRead = false, configurationWritten = false, gpu = "off" });
        } finally { Array.Clear(plain, 0, plain.Length); if (cipher != null) Array.Clear(cipher, 0, cipher.Length); if (restored != null) Array.Clear(restored, 0, restored.Length); }
    }
    [STAThread] static int Main(string[] args) {
        try {
            Require(args.Length >= 1);
            if (args[0] == "self-test" && args.Length == 1) { SelfTest(); return 0; }
            if (args[0] == "read" && args.Length == 3) { ReadCredential(args[1], args[2]); return 0; }
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (args[0] == "bind" && args.Length == 1) Bind();
            else if (args[0] == "approve" && args.Length == 1) Approve();
            else if (args[0] == "gateway" && args.Length == 1) Gateway();
            else throw Invalid();
            return 0;
        } catch {
            try { byte[] bytes = Encoding.ASCII.GetBytes("LOCAL_HELPER_REJECTED\n"); using (Stream error = Console.OpenStandardError()) { error.Write(bytes, 0, bytes.Length); error.Flush(); } } catch { }
            return 1;
        }
    }
}
