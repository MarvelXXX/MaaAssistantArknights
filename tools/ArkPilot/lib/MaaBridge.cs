using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// One MaaCore instance per worker process. The callback runs on native threads.
public static class MaaBridge
{
    private const string Core = "MaaCore.dll";
    private delegate void Callback(int message, IntPtr details, IntPtr arg);
    private static readonly Callback OnMessage = Message;
    private static readonly ManualResetEvent Terminal = new ManualResetEvent(false);
    private static volatile bool cancelled, failed, completed;

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetDllDirectory(string folder);
    [DllImport(Core)] private static extern IntPtr AsstGetVersion();
    [DllImport(Core)] private static extern byte AsstSetUserDir(byte[] dir);
    [DllImport(Core)] private static extern byte AsstLoadResource(byte[] dir);
    [DllImport(Core)] private static extern IntPtr AsstCreateEx(Callback callback, IntPtr arg);
    [DllImport(Core)] private static extern byte AsstConnect(IntPtr handle, byte[] adb, byte[] serial, byte[] config);
    [DllImport(Core)] private static extern int AsstAppendTask(IntPtr handle, byte[] type, byte[] json);
    [DllImport(Core)] private static extern byte AsstStart(IntPtr handle);
    [DllImport(Core)] private static extern byte AsstStop(IntPtr handle);
    [DllImport(Core)] private static extern void AsstDestroy(IntPtr handle);

    private static byte[] Utf8(string value) { return Encoding.UTF8.GetBytes(value + "\0"); }
    private static string Text(IntPtr ptr)
    {
        if (ptr == IntPtr.Zero) return "";
        int length = 0;
        while (Marshal.ReadByte(ptr, length) != 0) length++;
        var bytes = new byte[length];
        Marshal.Copy(ptr, bytes, 0, length);
        return Encoding.UTF8.GetString(bytes);
    }
    private static void Message(int id, IntPtr details, IntPtr arg)
    {
        if (id == 0 || id == 10000 || id == 10004) failed = true;
        if (id == 10002) completed = true;
        Console.WriteLine(id + "\t" + Text(details).Replace("\r", "").Replace("\n", ""));
        if (id == 3 || id == 0 || id == 10004 || id == 10000) Terminal.Set();
    }
    private static void Require(bool ok, string operation)
    {
        if (!ok) throw new InvalidOperationException(operation);
    }
    public static void Run(string home, string work, string client, string adb, string serial,
                           string type, string json, bool prepare)
    {
        Require(SetDllDirectory(home), "SetDllDirectory");
        Console.WriteLine("version\t" + Text(AsstGetVersion()));
        var watcher = new Thread(delegate() { Console.ReadLine(); cancelled = true; });
        watcher.IsBackground = true;
        watcher.Start();
        Require(AsstSetUserDir(Utf8(work)) != 0, "AsstSetUserDir");
        Require(AsstLoadResource(Utf8(home)) != 0, "AsstLoadResource");
        if (!String.IsNullOrEmpty(client) && client != "Official" && client != "Bilibili")
            Require(AsstLoadResource(Utf8(Path.Combine(home, "resource", "global", client))) != 0, "global resources");
        if (cancelled) throw new OperationCanceledException();
        IntPtr handle = AsstCreateEx(OnMessage, IntPtr.Zero);
        Require(handle != IntPtr.Zero, "AsstCreateEx");
        try {
            if (!String.IsNullOrEmpty(serial) && !prepare)
                Require(AsstConnect(handle, Utf8(adb), Utf8(serial), Utf8("General")) != 0, "AsstConnect");
            Require(AsstAppendTask(handle, Utf8(type), Utf8(json)) != 0, "AsstAppendTask");
            if (prepare) return;
            if (cancelled) throw new OperationCanceledException();
            Require(AsstStart(handle) != 0, "AsstStart");
            while (!Terminal.WaitOne(100)) {
                if (cancelled) { AsstStop(handle); throw new OperationCanceledException(); }
            }
            Require(completed && !failed, "task chain incomplete");
        } finally { AsstDestroy(handle); }
    }
}
