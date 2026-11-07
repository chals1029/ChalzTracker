Option Explicit
Dim shell, fso, folder, exePath, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
exePath = fso.BuildPath(folder, "ChalzTracker.exe")
If fso.FileExists(exePath) Then
  command = Chr(34) & exePath & Chr(34)
Else
  command = "node.exe " & Chr(34) & fso.BuildPath(folder, "server.js") & Chr(34) & " --open --close-with-window"
End If
On Error Resume Next
result = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  MsgBox "Could not start ChalzTracker. Make sure Node.js is installed and on PATH.", vbExclamation, "ChalzTracker"
End If
