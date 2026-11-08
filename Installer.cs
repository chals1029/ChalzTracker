using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Diagnostics;

[assembly: AssemblyTitle("ChalzTracker Setup")]
[assembly: AssemblyProduct("ChalzTracker")]
[assembly: AssemblyVersion("2.1.1.0")]
[assembly: AssemblyFileVersion("2.1.1.0")]

namespace ChalzTrackerSetup
{
    internal sealed class SetupForm : Form
    {
        private readonly TextBox destination = new TextBox();
        private readonly Button browse = new Button();
        private readonly Button install = new Button();
        private readonly Label status = new Label();
        private readonly ProgressBar progress = new ProgressBar();
        private bool busy;
        private bool installed;

        public SetupForm()
        {
            Text = "ChalzTracker Setup";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(520, 235);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            Font = new Font("Segoe UI", 9F);
            using (Stream icon = Assembly.GetExecutingAssembly().GetManifestResourceStream("setup.ico"))
            {
                if (icon != null) Icon = new Icon(icon);
            }

            var title = new Label { Text = "Install ChalzTracker", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Location = new Point(18, 18) };
            var description = new Label { Text = "Choose the folder where ChalzTracker should be installed.", AutoSize = true, Location = new Point(18, 49) };
            destination.SetBounds(20, 78, 385, 25);
            destination.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ChalzTracker");
            browse.SetBounds(414, 76, 85, 28);
            browse.Text = "Browse…";
            browse.Click += ChooseFolder;
            status.SetBounds(20, 116, 479, 40);
            status.Text = "Your existing account data and settings are stored separately.";
            progress.SetBounds(20, 163, 479, 8);
            progress.Style = ProgressBarStyle.Marquee;
            progress.Visible = false;
            install.SetBounds(389, 187, 110, 30);
            install.Text = "Install";
            install.Click += InstallClicked;
            Controls.AddRange(new Control[] { title, description, destination, browse, status, progress, install });
            FormClosing += (sender, args) => { if (busy) args.Cancel = true; };
        }

        private void ChooseFolder(object sender, EventArgs args)
        {
            using (var picker = new FolderBrowserDialog())
            {
                picker.Description = "Choose the ChalzTracker installation folder";
                picker.ShowNewFolderButton = true;
                if (Directory.Exists(destination.Text)) picker.SelectedPath = destination.Text;
                if (picker.ShowDialog(this) == DialogResult.OK) destination.Text = picker.SelectedPath;
            }
        }

        private async void InstallClicked(object sender, EventArgs args)
        {
            if (installed)
            {
                try
                {
                    string folder = Path.GetFullPath(destination.Text.Trim());
                    Process.Start(new ProcessStartInfo { FileName = Path.Combine(folder, "ChalzTracker.exe"), WorkingDirectory = folder, UseShellExecute = true });
                    Close();
                }
                catch (Exception ex) { MessageBox.Show(this, ex.Message, "Could not start ChalzTracker", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                return;
            }

            string target;
            try
            {
                if (String.IsNullOrWhiteSpace(destination.Text)) throw new InvalidOperationException("Choose an installation folder.");
                target = Path.GetFullPath(destination.Text.Trim());
                if (String.Equals(target.TrimEnd(Path.DirectorySeparatorChar), Path.GetPathRoot(target).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Choose a folder, not the root of a drive.");
                if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0 &&
                    MessageBox.Show(this, "The selected folder is not empty. Existing app files with the same names will be replaced. Continue?", "Existing files", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Choose an installation folder", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }

            busy = true;
            destination.Enabled = false;
            browse.Enabled = false;
            install.Enabled = false;
            progress.Visible = true;
            status.Text = "Installing… Please keep this window open.";
            try
            {
                await Task.Run(() => InstallPackage(target));
                installed = true;
                status.Text = "Installation complete. You can start ChalzTracker now.";
                install.Text = "Launch";
            }
            catch (Exception ex)
            {
                status.Text = "Installation failed. " + ex.Message;
                destination.Enabled = true;
                browse.Enabled = true;
                MessageBox.Show(this, ex.Message, "Installation failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                busy = false;
                progress.Visible = false;
                install.Enabled = true;
            }
        }

        private sealed class Change
        {
            public string Target;
            public string Backup;
            public bool Existed;
        }

        private static string SafePath(string root, string relative)
        {
            string[] parts = relative.Split('/');
            if (relative.IndexOf('\\') >= 0 || relative.IndexOf(':') >= 0) throw new InvalidDataException("The package contains an invalid path.");
            foreach (string part in parts)
                if (String.IsNullOrEmpty(part) || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                    throw new InvalidDataException("The package contains an invalid path.");
            string full = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The package contains a path outside the installation folder.");
            return full;
        }

        private static void CheckReparsePoints(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Installation paths cannot contain shortcuts or reparse points: " + current);
                string parent = Path.GetDirectoryName(current);
                if (String.Equals(current, parent, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
        }

        private static void InstallPackage(string target)
        {
            string work = Path.Combine(Path.GetTempPath(), "chalz-setup-" + Guid.NewGuid().ToString("N"));
            string stage = Path.Combine(work, "stage");
            string backup = Path.Combine(work, "backup");
            var changes = new List<Change>();
            var directories = new List<string>();
            bool keepBackup = false;
            try
            {
                Directory.CreateDirectory(stage);
                using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("package.zip"))
                {
                    if (resource == null) throw new InvalidDataException("The setup package is missing.");
                    using (var zip = new ZipArchive(resource, ZipArchiveMode.Read))
                    {
                        long total = 0;
                        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (ZipArchiveEntry entry in zip.Entries)
                        {
                            if (!entry.FullName.StartsWith("ChalzTracker/", StringComparison.Ordinal)) throw new InvalidDataException("The package has an unexpected file.");
                            string relative = entry.FullName.Substring("ChalzTracker/".Length).TrimEnd('/');
                            if (relative.Length == 0) continue;
                            if (!seen.Add(relative)) throw new InvalidDataException("The package has duplicate paths.");
                            string file = SafePath(stage, relative);
                            total += entry.Length;
                            if (zip.Entries.Count > 20000 || total > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("The package is too large.");
                            if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) { Directory.CreateDirectory(file); continue; }
                            Directory.CreateDirectory(Path.GetDirectoryName(file));
                            using (Stream input = entry.Open())
                            using (FileStream output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                        }
                    }
                }
                foreach (string required in new[] { "ChalzTracker.exe", "package.json", "main.js", "updater.js", "updater-helper.ps1", "dist-app/ChalzTracker-desktop.exe" })
                    if (!File.Exists(SafePath(stage, required))) throw new InvalidDataException("The package is incomplete: " + required);

                string data = Environment.GetEnvironmentVariable("CHALZTRACKER_HOME");
                if (String.IsNullOrWhiteSpace(data)) data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".chalztracker");
                data = Path.GetFullPath(data).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                foreach (string file in Directory.GetFiles(stage, "*", SearchOption.AllDirectories))
                {
                    string relative = file.Substring(stage.Length).TrimStart(Path.DirectorySeparatorChar).Replace(Path.DirectorySeparatorChar, '/');
                    string output = SafePath(target, relative);
                    if ((output + Path.DirectorySeparatorChar).StartsWith(data, StringComparison.OrdinalIgnoreCase)) throw new IOException("The installation would overwrite the account data folder.");
                    CheckReparsePoints(output);
                    if (Directory.Exists(output)) throw new IOException("A folder conflicts with an app file: " + output);
                }
                foreach (string file in Directory.GetFiles(stage, "*", SearchOption.AllDirectories))
                {
                    string relative = file.Substring(stage.Length).TrimStart(Path.DirectorySeparatorChar).Replace(Path.DirectorySeparatorChar, '/');
                    string output = SafePath(target, relative);
                    CheckReparsePoints(output);
                    string saved = SafePath(backup, relative);
                    bool existed = File.Exists(output);
                    if (existed)
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(saved));
                        File.Copy(output, saved, false);
                    }
                    string parent = Path.GetDirectoryName(output);
                    var missing = new List<string>();
                    while (!Directory.Exists(parent)) { missing.Add(parent); parent = Path.GetDirectoryName(parent); }
                    for (int i = missing.Count - 1; i >= 0; i--) { Directory.CreateDirectory(missing[i]); directories.Add(missing[i]); }
                    if (existed)
                    {
                        changes.Add(new Change { Target = output, Backup = saved, Existed = true });
                        File.Copy(file, output, true);
                    }
                    else
                    {
                        using (FileStream created = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            changes.Add(new Change { Target = output, Backup = saved, Existed = false });
                            using (FileStream input = File.OpenRead(file)) input.CopyTo(created);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                var failures = new List<string>();
                for (int i = changes.Count - 1; i >= 0; i--)
                {
                    try { if (changes[i].Existed) File.Copy(changes[i].Backup, changes[i].Target, true); else if (File.Exists(changes[i].Target)) File.Delete(changes[i].Target); }
                    catch (Exception rollback) { failures.Add(rollback.Message); }
                }
                for (int i = directories.Count - 1; i >= 0; i--)
                    try { Directory.Delete(directories[i], false); } catch (Exception rollback) { failures.Add(rollback.Message); }
                if (failures.Count > 0)
                {
                    keepBackup = true;
                    throw new IOException(ex.Message + " Rollback was incomplete. Backups are in " + backup + ". " + String.Join("; ", failures), ex);
                }
                throw;
            }
            finally { if (!keepBackup) try { Directory.Delete(work, true); } catch { } }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }
}
