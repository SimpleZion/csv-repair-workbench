using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using static CsvShared;

Console.OutputEncoding = Encoding.UTF8;

try
{
    var options = Options.Parse(args);
    if (options.ShowHelp)
    {
        Console.WriteLine(HelpText());
        return 0;
    }

    var result = options.Command switch
    {
        "scan" => ScanCommand.Run(options),
        "repair" => RepairCommand.Run(options),
        "validate" => ValidateCommand.Run(options),
        "audit" => AuditCommand.Run(options),
        "benchmark" => BenchmarkCommand.Run(options),
        _ => throw new ArgumentException($"Unknown command: {options.Command}"),
    };

    var jsonOptions = new JsonSerializerOptions
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
    Console.WriteLine(JsonSerializer.Serialize(result, jsonOptions));
    return result.ExitCode;
}
catch (Exception error)
{
    Console.Error.WriteLine($"{error.GetType().Name}: {error.Message}");
    return 2;
}

internal static class CsvShared
{
    public const byte delimiterByte = (byte)',';
    public const byte quoteByte = (byte)'"';
    public const byte carriageReturnByte = (byte)'\r';
    public const byte lineFeedByte = (byte)'\n';
    private static readonly Encoding snippetEncoding = Encoding.GetEncoding(
        "UTF-8",
        EncoderFallback.ExceptionFallback,
        new DecoderReplacementFallback(""));

    public static string HelpText() => """
    CsvRepairKit

    Commands:
      scan      Scan one CSV file or a directory tree and write issue details.
      repair    Repair malformed CSV into canonical RFC 4180 CSV.
      validate  Strictly validate one CSV file.
      audit     Summarize issue/change JSONL logs for review.
      benchmark Measure scan/repair/validate throughput on a fixed input.

    Repair example:
      dotnet run --project engine/CsvRepairKit -- repair --input input.csv --output outputs/input.clean.csv

    Batch examples:
      dotnet run --project engine/CsvRepairKit -- scan --root <your-csv-folder> --output-dir outputs\csv_scan --exclude-dir backup --log-all-issues
      dotnet run --project engine/CsvRepairKit -- repair --root <your-csv-folder> --output-dir outputs\csv_fixed --exclude *.bak.csv --log-all-changes

    Important options:
      --input PATH              Input CSV file.
      --root PATH               Directory tree to scan or repair.
      --output PATH             Output CSV file for repair.
      --output-dir PATH         Output directory for scan artifacts or repaired batch files.
      --report PATH             JSON repair report path.
      --issue-log PATH          JSONL issue log path.
      --change-log PATH         JSONL repair-change log path.
      --in-place                Replace each source CSV after a repaired temporary file validates.
      --exclude PATTERN         Exclude path glob; can be repeated.
      --exclude-dir PATTERN     Exclude directory glob or name; can be repeated.
      --workers N               File-level parallelism for directory mode.
      --iterations N            Benchmark iterations. Default: 1.
      --expected-columns N      Expected column count. Default: auto from header.
      --all-quoted auto|true|false
                                Whether records are expected to use quoted fields. Default: auto from header.
      --max-examples N          Maximum issue examples in the report. Default: 20.
      --log-all-issues          Write every scan issue to issues.jsonl or --issue-log.
      --log-all-changes         Write every repair change to changes.jsonl or --change-log.
      --write-bom               Write UTF-8 BOM in repaired output. Default: no BOM.
      --no-validate             Skip strict validation after repair.
    """;

    public static bool IsNewline(byte byteValue)
    {
        return byteValue is carriageReturnByte or lineFeedByte;
    }

    public static string DecodeSnippet(string path, long offset, int radius = 160)
    {
        try
        {
            var fileInfo = new FileInfo(path);
            var start = Math.Max(0, offset - radius);
            var length = (int)Math.Min(fileInfo.Length - start, radius * 2);
            var data = new byte[length];
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            stream.Seek(start, SeekOrigin.Begin);
            var bytesRead = stream.Read(data, 0, data.Length);
            return DecodeSnippetBytes(data.AsSpan(0, bytesRead));
        }
        catch (Exception error)
        {
            return $"<snippet_error {error.GetType().Name}: {error.Message}>";
        }
    }

    public static string DecodeSnippetBytes(ReadOnlySpan<byte> bytes)
    {
        return snippetEncoding.GetString(bytes)
            .Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
    }

    public static void RequireFile(string path, string optionName)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException($"{optionName} is required");
        }
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"File not found for {optionName}", path);
        }
    }

    public static string NowText()
    {
        return DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);
    }
}

internal static class InputFileResolver
{
    public static List<string> ResolveCsvFiles(Options options)
    {
        IEnumerable<string> paths;
        if (!string.IsNullOrWhiteSpace(options.InputPath))
        {
            RequireFile(options.InputPath, "--input");
            paths = [Path.GetFullPath(options.InputPath)];
        }
        else if (!string.IsNullOrWhiteSpace(options.RootPath))
        {
            if (!Directory.Exists(options.RootPath))
            {
                throw new DirectoryNotFoundException(options.RootPath);
            }
            paths = Directory.EnumerateFiles(options.RootPath, "*.csv", SearchOption.AllDirectories);
        }
        else
        {
            throw new ArgumentException("--input or --root is required");
        }

        var rootFullPath = !string.IsNullOrWhiteSpace(options.RootPath)
            ? Path.GetFullPath(options.RootPath)
            : "";
        var filtered = new List<string>();
        foreach (var path in paths)
        {
            var fullPath = Path.GetFullPath(path);
            var relativePath = string.IsNullOrWhiteSpace(rootFullPath)
                ? Path.GetFileName(fullPath)
                : Path.GetRelativePath(rootFullPath, fullPath);
            if (IsExcluded(fullPath, relativePath, options))
            {
                continue;
            }
            filtered.Add(fullPath);
        }

        return filtered.OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static bool IsExcluded(string fullPath, string relativePath, Options options)
    {
        var normalizedFullPath = NormalizePath(fullPath);
        var normalizedRelativePath = NormalizePath(relativePath);
        foreach (var pattern in options.ExcludePatterns)
        {
            if (PathPatternMatch(normalizedRelativePath, pattern) || PathPatternMatch(normalizedFullPath, pattern))
            {
                return true;
            }
        }

        var directoryNames = normalizedRelativePath.Split('/', StringSplitOptions.RemoveEmptyEntries).SkipLast(1).ToArray();
        foreach (var pattern in options.ExcludeDirectoryPatterns)
        {
            var normalizedPattern = NormalizePath(pattern);
            foreach (var directoryName in directoryNames)
            {
                if (PathPatternMatch(directoryName, normalizedPattern) || PathPatternMatch(string.Join('/', directoryNames), normalizedPattern))
                {
                    return true;
                }
            }
        }
        return false;
    }

    private static string NormalizePath(string value)
    {
        return value.Replace('\\', '/').Trim();
    }

    private static bool PathPatternMatch(string value, string pattern)
    {
        var normalizedPattern = NormalizePath(pattern);
        if (string.IsNullOrWhiteSpace(normalizedPattern))
        {
            return false;
        }
        if (!normalizedPattern.Contains('*') && !normalizedPattern.Contains('?'))
        {
            return value.Contains(normalizedPattern, StringComparison.OrdinalIgnoreCase);
        }

        var regex = "^" + Regex.Escape(normalizedPattern)
            .Replace("\\*", ".*", StringComparison.Ordinal)
            .Replace("\\?", ".", StringComparison.Ordinal) + "$";
        return Regex.IsMatch(value, regex, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
}

internal static class BatchPaths
{
    public static string ResolveRunDirectory(string configuredOutputDirectory, string defaultName)
    {
        var baseDirectory = string.IsNullOrWhiteSpace(configuredOutputDirectory)
            ? Path.Combine("outputs", defaultName)
            : configuredOutputDirectory;
        var timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
        return Path.GetFullPath(Path.Combine(baseDirectory, timestamp));
    }

    public static void WriteScanSummaryCsv(string path, IEnumerable<ValidationResult> results)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var writer = new StreamWriter(path, false, new UTF8Encoding(true));
        writer.WriteLine("status,path,size_bytes,expected_columns,records_scanned_including_header,physical_lines_scanned,issue_count,elapsed_seconds,first_issue_type,first_record_number,first_physical_line_number,first_byte_offset,first_column_number,first_detail");
        foreach (var result in results)
        {
            var firstIssue = result.Issues.FirstOrDefault();
            writer.WriteLine(string.Join(",", new[]
            {
                EscapeCsv(result.Status),
                EscapeCsv(result.Path),
                result.SizeBytes.ToString(CultureInfo.InvariantCulture),
                result.ExpectedColumns?.ToString(CultureInfo.InvariantCulture) ?? "",
                result.RecordsScannedIncludingHeader.ToString(CultureInfo.InvariantCulture),
                result.PhysicalLinesScanned.ToString(CultureInfo.InvariantCulture),
                result.IssueCount.ToString(CultureInfo.InvariantCulture),
                result.ElapsedSeconds.ToString(CultureInfo.InvariantCulture),
                EscapeCsv(firstIssue?.IssueType ?? ""),
                firstIssue?.RecordNumber.ToString(CultureInfo.InvariantCulture) ?? "",
                firstIssue?.PhysicalLineNumber.ToString(CultureInfo.InvariantCulture) ?? "",
                firstIssue?.ByteOffset.ToString(CultureInfo.InvariantCulture) ?? "",
                firstIssue?.ColumnNumber.ToString(CultureInfo.InvariantCulture) ?? "",
                EscapeCsv(firstIssue?.Detail ?? ""),
            }));
        }
    }

    public static void WriteRepairSummaryCsv(string path, IEnumerable<RepairResult> results)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        using var writer = new StreamWriter(path, false, new UTF8Encoding(true));
        writer.WriteLine("status,input_path,output_path,in_place,overwrote_input,input_size_bytes,output_size_bytes,expected_columns,records_written_including_header,total_repair_change_count,column_mismatch_count,validation_status,elapsed_seconds");
        foreach (var result in results)
        {
            writer.WriteLine(string.Join(",", new[]
            {
                EscapeCsv(result.Status),
                EscapeCsv(result.InputPath),
                EscapeCsv(result.OutputPath),
                result.InPlace ? "true" : "false",
                result.OverwroteInput ? "true" : "false",
                result.InputSizeBytes.ToString(CultureInfo.InvariantCulture),
                result.OutputSizeBytes.ToString(CultureInfo.InvariantCulture),
                result.ExpectedColumns?.ToString(CultureInfo.InvariantCulture) ?? "",
                result.RecordsWrittenIncludingHeader.ToString(CultureInfo.InvariantCulture),
                result.TotalRepairChangeCount.ToString(CultureInfo.InvariantCulture),
                result.ColumnMismatchCount.ToString(CultureInfo.InvariantCulture),
                EscapeCsv(result.Validation?.Status ?? ""),
                result.ElapsedSeconds.ToString(CultureInfo.InvariantCulture),
            }));
        }
    }

    private static string EscapeCsv(string value)
    {
        return "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }
}

internal sealed class JsonLineSink : IDisposable
{
    private readonly object writeLock = new();
    private readonly bool flushEveryWrite;
    private readonly StreamWriter writer;

    public JsonLineSink(string path, bool flushEveryWrite = false)
    {
        Path = System.IO.Path.GetFullPath(path);
        this.flushEveryWrite = flushEveryWrite;
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        writer = new StreamWriter(Path, false, new UTF8Encoding(false), bufferSize: 1024 * 1024);
    }

    public string Path { get; }

    public void Write(object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOutput.LineOptions);
        lock (writeLock)
        {
            writer.WriteLine(json);
            if (flushEveryWrite)
            {
                writer.Flush();
            }
        }
    }

    public void Dispose()
    {
        lock (writeLock)
        {
            writer.Flush();
            writer.Dispose();
        }
    }
}

internal static class JsonLineReader
{
    public static IEnumerable<JsonElement> ReadObjects(string path)
    {
        using var reader = new StreamReader(path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 1024 * 1024);
        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            using var document = JsonDocument.Parse(line);
            yield return document.RootElement.Clone();
        }
    }

    public static string GetString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property))
        {
            return "";
        }
        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString() ?? "",
            JsonValueKind.Number => property.ToString(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => property.ToString(),
        };
    }
}

internal static class RepairCommand
{
    public static CommandResult Run(Options options)
    {
        if (!string.IsNullOrWhiteSpace(options.RootPath))
        {
            return BatchRepairCommand.Run(options);
        }

        RequireFile(options.InputPath, "--input");
        if (!options.InPlace && string.IsNullOrWhiteSpace(options.OutputPath))
        {
            options.UseDefaultSingleRepairOutputPath();
        }

        var stopwatch = Stopwatch.StartNew();
        var effectiveOutputPath = options.InPlace
            ? InPlaceRepairFiles.CreateTempPath(options.InputPath)
            : Path.GetFullPath(options.OutputPath);
        if (options.OutputPathWasDefault && File.Exists(effectiveOutputPath))
        {
            throw new IOException($"default repair output already exists: {effectiveOutputPath}. Pass --output to choose a different file or use --in-place intentionally.");
        }
        var singleRepairArtifactDirectory = ResolveSingleRepairArtifactDirectory(options);
        var reportPath = ResolveSingleRepairReportPath(options, singleRepairArtifactDirectory);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(effectiveOutputPath))!);
        if (!string.IsNullOrWhiteSpace(reportPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(reportPath))!);
        }
        var changeLogPath = options.LogAllChanges
            ? !string.IsNullOrWhiteSpace(options.ChangeLogPath)
                ? Path.GetFullPath(options.ChangeLogPath)
                : ResolveSingleRepairChangeLogPath(options, effectiveOutputPath, singleRepairArtifactDirectory)
            : "";
        if (!string.IsNullOrWhiteSpace(changeLogPath))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(changeLogPath))!);
            if (string.IsNullOrWhiteSpace(options.ChangeLogPath) && File.Exists(changeLogPath))
            {
                throw new IOException($"default repair change log already exists: {changeLogPath}. Pass --change-log to choose a different file.");
            }
        }
        using var changeSink = options.LogAllChanges ? new JsonLineSink(changeLogPath) : null;

        var fileOptions = options.InPlace
            ? options.CloneForFile(options.InputPath, effectiveOutputPath, reportPath)
            : options;

        RepairResult repairResult;
        try
        {
            repairResult = CsvRepairer.Repair(fileOptions, change => changeSink?.Write(change));
        }
        catch
        {
            if (options.InPlace)
            {
                InPlaceRepairFiles.DeleteIfExists(effectiveOutputPath);
            }
            throw;
        }
        ValidationResult? validation = null;
        if (options.ValidateAfterRepair)
        {
            validation = CsvValidator.Validate(effectiveOutputPath, options.MaxExamples);
        }

        repairResult.ElapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 3);
        repairResult.Validation = validation;
        repairResult.InPlace = options.InPlace;
        repairResult.ReportPath = reportPath;
        repairResult.ChangeLogPath = changeLogPath;
        repairResult.Status = validation is null
            ? repairResult.Status
            : validation.Status == "ok" && repairResult.ColumnMismatchCount == 0
                ? "ok"
                : "issue";
        if (options.InPlace)
        {
            repairResult.OverwroteInput = repairResult.Status == "ok";
            if (repairResult.OverwroteInput)
            {
                InPlaceRepairFiles.ReplaceOriginal(effectiveOutputPath, options.InputPath);
                repairResult.OutputPath = Path.GetFullPath(options.InputPath);
                repairResult.OutputSizeBytes = new FileInfo(options.InputPath).Length;
            }
            else
            {
                InPlaceRepairFiles.DeleteIfExists(effectiveOutputPath);
            }
        }

        if (!string.IsNullOrWhiteSpace(reportPath))
        {
            File.WriteAllText(
                reportPath,
                JsonSerializer.Serialize(repairResult, JsonOutput.Options) + Environment.NewLine,
                new UTF8Encoding(false));
        }

        return new CommandResult(repairResult.Status == "ok" ? 0 : 1, repairResult);
    }

    private static string ResolveSingleRepairArtifactDirectory(Options options)
    {
        if (options.InPlace && !string.IsNullOrWhiteSpace(options.OutputDirectory))
        {
            return Path.Combine(BatchPaths.ResolveRunDirectory(options.OutputDirectory, "csv_repair"), "single_file");
        }
        return "";
    }

    private static string ResolveSingleRepairReportPath(Options options, string artifactDirectory)
    {
        if (!string.IsNullOrWhiteSpace(options.ReportPath))
        {
            return Path.GetFullPath(options.ReportPath);
        }
        if (!string.IsNullOrWhiteSpace(artifactDirectory))
        {
            var inputPath = Path.GetFullPath(options.InputPath);
            var inputName = Path.GetFileNameWithoutExtension(inputPath);
            return Path.Combine(artifactDirectory, $"{inputName}_repair_report.json");
        }
        return "";
    }

    private static string ResolveSingleRepairChangeLogPath(Options options, string effectiveOutputPath, string artifactDirectory)
    {
        if (!string.IsNullOrWhiteSpace(artifactDirectory))
        {
            var inputPath = Path.GetFullPath(options.InputPath);
            var inputName = Path.GetFileNameWithoutExtension(inputPath);
            return Path.Combine(artifactDirectory, $"{inputName}.changes.jsonl");
        }
        return Path.ChangeExtension(Path.GetFullPath(effectiveOutputPath), ".changes.jsonl");
    }
}

internal static class ScanCommand
{
    public static CommandResult Run(Options options)
    {
        var stopwatch = Stopwatch.StartNew();
        var inputFiles = InputFileResolver.ResolveCsvFiles(options);
        var outputDirectory = BatchPaths.ResolveRunDirectory(options.OutputDirectory, "csv_scan");
        Directory.CreateDirectory(outputDirectory);

        var progressPath = Path.Combine(outputDirectory, "progress.jsonl");
        var summaryCsvPath = Path.Combine(outputDirectory, "file_summary.csv");
        var issueLogPath = !string.IsNullOrWhiteSpace(options.IssueLogPath)
            ? Path.GetFullPath(options.IssueLogPath)
            : Path.Combine(outputDirectory, "issues.jsonl");
        var issueSink = options.LogAllIssues ? new JsonLineSink(issueLogPath) : null;
        var progressSink = new JsonLineSink(progressPath, flushEveryWrite: true);
        var fileResults = new List<ValidationResult>();
        var fileResultsLock = new object();
        long scannedCount = 0;
        long issueFileCount = 0;
        long totalIssueCount = 0;
        long scannedBytes = 0;

        progressSink.Write(new
        {
            time = NowText(),
            status = "started",
            command = "scan",
            root = options.RootPath,
            input = options.InputPath,
            csv_count = inputFiles.Count,
            workers = options.Workers,
            issue_log_path = issueSink?.Path,
            exclusions = options.ExcludePatterns,
            excluded_dirs = options.ExcludeDirectoryPatterns,
        });

        var parallelOptions = new ParallelOptions { MaxDegreeOfParallelism = options.Workers };
        Parallel.ForEach(inputFiles, parallelOptions, filePath =>
        {
            var validation = CsvValidator.Validate(filePath, options.MaxExamples, issue =>
            {
                issueSink?.Write(new IssueLogRecord
                {
                    Path = Path.GetFullPath(filePath),
                    IssueType = issue.IssueType,
                    RecordNumber = issue.RecordNumber,
                    PhysicalLineNumber = issue.PhysicalLineNumber,
                    ByteOffset = issue.ByteOffset,
                    ColumnNumber = issue.ColumnNumber,
                    Detail = issue.Detail,
                    Snippet = issue.Snippet,
                });
            });

            Interlocked.Increment(ref scannedCount);
            Interlocked.Add(ref scannedBytes, validation.SizeBytes);
            Interlocked.Add(ref totalIssueCount, validation.IssueCount);
            if (validation.IssueCount > 0)
            {
                Interlocked.Increment(ref issueFileCount);
            }

            lock (fileResultsLock)
            {
                fileResults.Add(validation);
            }

            var current = Interlocked.Read(ref scannedCount);
            if (current == 1 || current % options.ProgressEvery == 0 || current == inputFiles.Count)
            {
                progressSink.Write(new
                {
                    time = NowText(),
                    status = current == inputFiles.Count ? "finished" : "running",
                    scanned_count = current,
                    csv_count = inputFiles.Count,
                    issue_file_count = Interlocked.Read(ref issueFileCount),
                    total_issue_count = Interlocked.Read(ref totalIssueCount),
                    scanned_gb = Math.Round(Interlocked.Read(ref scannedBytes) / Math.Pow(1024, 3), 3),
                    elapsed_seconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 1),
                });
            }
        });

        issueSink?.Dispose();
        progressSink.Dispose();
        BatchPaths.WriteScanSummaryCsv(summaryCsvPath, fileResults.OrderBy(item => item.Path, StringComparer.OrdinalIgnoreCase));

        var result = new BatchScanResult
        {
            Status = issueFileCount == 0 ? "ok" : "issue",
            CsvCount = inputFiles.Count,
            IssueFileCount = issueFileCount,
            TotalIssueCount = totalIssueCount,
            OutputDirectory = outputDirectory,
            ProgressPath = progressPath,
            SummaryCsvPath = summaryCsvPath,
            IssueLogPath = issueSink?.Path,
            ElapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 3),
        };
        return new CommandResult(result.Status == "ok" ? 0 : 1, result);
    }
}

internal static class BatchRepairCommand
{
    public static CommandResult Run(Options options)
    {
        var stopwatch = Stopwatch.StartNew();
        var inputFiles = InputFileResolver.ResolveCsvFiles(options);
        var outputDirectory = BatchPaths.ResolveRunDirectory(options.OutputDirectory, "csv_repair_batch");
        Directory.CreateDirectory(outputDirectory);

        var progressPath = Path.Combine(outputDirectory, "progress.jsonl");
        var summaryCsvPath = Path.Combine(outputDirectory, "file_summary.csv");
        var changeLogPath = !string.IsNullOrWhiteSpace(options.ChangeLogPath)
            ? Path.GetFullPath(options.ChangeLogPath)
            : Path.Combine(outputDirectory, "changes.jsonl");
        var changeSink = options.LogAllChanges ? new JsonLineSink(changeLogPath) : null;
        var progressSink = new JsonLineSink(progressPath, flushEveryWrite: true);
        var fileResults = new List<RepairResult>();
        var fileResultsLock = new object();
        long repairedCount = 0;
        long issueFileCount = 0;
        long totalChangeCount = 0;
        long totalInputBytes = 0;

        progressSink.Write(new
        {
            time = NowText(),
            status = "started",
            command = "repair",
            root = options.RootPath,
            csv_count = inputFiles.Count,
            workers = options.Workers,
            in_place = options.InPlace,
            output_directory = outputDirectory,
            change_log_path = changeSink?.Path,
            exclusions = options.ExcludePatterns,
            excluded_dirs = options.ExcludeDirectoryPatterns,
        });

        var parallelOptions = new ParallelOptions { MaxDegreeOfParallelism = options.Workers };
        Parallel.ForEach(inputFiles, parallelOptions, inputFile =>
        {
            var relativePath = Path.GetRelativePath(Path.GetFullPath(options.RootPath), Path.GetFullPath(inputFile));
            var outputPath = options.InPlace
                ? InPlaceRepairFiles.CreateTempPath(inputFile)
                : Path.Combine(outputDirectory, relativePath);
            var reportPath = Path.ChangeExtension(Path.Combine(outputDirectory, relativePath), ".repair_report.json");
            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);

            var fileOptions = options.CloneForFile(inputFile, outputPath, reportPath);
            RepairResult repairResult;
            try
            {
                repairResult = CsvRepairer.Repair(fileOptions, change =>
                {
                    changeSink?.Write(change);
                });
            }
            catch
            {
                if (options.InPlace)
                {
                    InPlaceRepairFiles.DeleteIfExists(outputPath);
                }
                throw;
            }
            ValidationResult? validation = null;
            if (options.ValidateAfterRepair)
            {
                validation = CsvValidator.Validate(outputPath, options.MaxExamples);
            }

            repairResult.Validation = validation;
            repairResult.InPlace = options.InPlace;
            repairResult.Status = validation is null
                ? repairResult.Status
                : validation.Status == "ok" && repairResult.ColumnMismatchCount == 0
                    ? "ok"
                    : "issue";
            if (options.InPlace)
            {
                repairResult.OverwroteInput = repairResult.Status == "ok";
                if (repairResult.OverwroteInput)
                {
                    InPlaceRepairFiles.ReplaceOriginal(outputPath, inputFile);
                    repairResult.OutputPath = Path.GetFullPath(inputFile);
                    repairResult.OutputSizeBytes = new FileInfo(inputFile).Length;
                }
                else
                {
                    InPlaceRepairFiles.DeleteIfExists(outputPath);
                }
            }
            File.WriteAllText(reportPath, JsonSerializer.Serialize(repairResult, JsonOutput.Options) + Environment.NewLine, new UTF8Encoding(false));

            Interlocked.Increment(ref repairedCount);
            Interlocked.Add(ref totalInputBytes, repairResult.InputSizeBytes);
            Interlocked.Add(ref totalChangeCount, repairResult.TotalRepairChangeCount);
            if (repairResult.Status != "ok")
            {
                Interlocked.Increment(ref issueFileCount);
            }
            lock (fileResultsLock)
            {
                fileResults.Add(repairResult);
            }

            var current = Interlocked.Read(ref repairedCount);
            if (current == 1 || current % options.ProgressEvery == 0 || current == inputFiles.Count)
            {
                progressSink.Write(new
                {
                    time = NowText(),
                    status = current == inputFiles.Count ? "finished" : "running",
                    repaired_count = current,
                    csv_count = inputFiles.Count,
                    issue_file_count = Interlocked.Read(ref issueFileCount),
                    total_change_count = Interlocked.Read(ref totalChangeCount),
                    processed_gb = Math.Round(Interlocked.Read(ref totalInputBytes) / Math.Pow(1024, 3), 3),
                    elapsed_seconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 1),
                });
            }
        });

        changeSink?.Dispose();
        progressSink.Dispose();
        BatchPaths.WriteRepairSummaryCsv(summaryCsvPath, fileResults.OrderBy(item => item.InputPath, StringComparer.OrdinalIgnoreCase));

        var result = new BatchRepairResult
        {
            Status = issueFileCount == 0 ? "ok" : "issue",
            CsvCount = inputFiles.Count,
            RepairedFileCount = repairedCount,
            IssueFileCount = issueFileCount,
            TotalChangeCount = totalChangeCount,
            OutputDirectory = outputDirectory,
            ProgressPath = progressPath,
            SummaryCsvPath = summaryCsvPath,
            ChangeLogPath = changeSink?.Path,
            ElapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 3),
        };
        return new CommandResult(result.Status == "ok" ? 0 : 1, result);
    }
}

internal static class ValidateCommand
{
    public static CommandResult Run(Options options)
    {
        RequireFile(options.InputPath, "--input");
        var result = CsvValidator.Validate(options.InputPath, options.MaxExamples);
        return new CommandResult(result.Status == "ok" ? 0 : 1, result);
    }
}

internal static class AuditCommand
{
    public static CommandResult Run(Options options)
    {
        var inputs = new List<string>();
        if (!string.IsNullOrWhiteSpace(options.InputPath))
        {
            inputs.Add(Path.GetFullPath(options.InputPath));
        }
        if (!string.IsNullOrWhiteSpace(options.IssueLogPath))
        {
            inputs.Add(Path.GetFullPath(options.IssueLogPath));
        }
        if (!string.IsNullOrWhiteSpace(options.ChangeLogPath))
        {
            inputs.Add(Path.GetFullPath(options.ChangeLogPath));
        }
        if (inputs.Count == 0)
        {
            throw new ArgumentException("audit needs --input, --issue-log, or --change-log");
        }

        var outputDirectory = BatchPaths.ResolveRunDirectory(options.OutputDirectory, "csv_audit");
        Directory.CreateDirectory(outputDirectory);
        var summaryJsonPath = Path.Combine(outputDirectory, "audit_summary.json");
        var summaryCsvPath = Path.Combine(outputDirectory, "audit_summary.csv");
        var result = new AuditResult
        {
            Status = "ok",
            OutputDirectory = outputDirectory,
            SummaryJsonPath = summaryJsonPath,
            SummaryCsvPath = summaryCsvPath,
        };

        foreach (var input in inputs.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            RequireFile(input, "--input/--issue-log/--change-log");
            foreach (var record in JsonLineReader.ReadObjects(input))
            {
                result.RowCount++;
                var path = JsonLineReader.GetString(record, "Path");
                var issueType = JsonLineReader.GetString(record, "IssueType");
                var column = JsonLineReader.GetString(record, "ColumnNumber");
                Increment(result.ByPath, string.IsNullOrWhiteSpace(path) ? "<unknown>" : path);
                Increment(result.ByIssueType, string.IsNullOrWhiteSpace(issueType) ? "<unknown>" : issueType);
                Increment(result.ByColumn, string.IsNullOrWhiteSpace(column) ? "<unknown>" : column);
            }
        }

        File.WriteAllText(summaryJsonPath, JsonSerializer.Serialize(result, JsonOutput.Options) + Environment.NewLine, new UTF8Encoding(false));
        WriteAuditCsv(summaryCsvPath, result);
        return new CommandResult(0, result);
    }

    private static void Increment(Dictionary<string, long> values, string key)
    {
        values.TryGetValue(key, out var count);
        values[key] = count + 1;
    }

    private static void WriteAuditCsv(string path, AuditResult result)
    {
        using var writer = new StreamWriter(path, false, new UTF8Encoding(true));
        writer.WriteLine("section,key,count");
        foreach (var item in result.ByIssueType.OrderByDescending(item => item.Value))
        {
            writer.WriteLine($"issue_type,{EscapeCsv(item.Key)},{item.Value}");
        }
        foreach (var item in result.ByColumn.OrderByDescending(item => item.Value))
        {
            writer.WriteLine($"column,{EscapeCsv(item.Key)},{item.Value}");
        }
        foreach (var item in result.ByPath.OrderByDescending(item => item.Value))
        {
            writer.WriteLine($"path,{EscapeCsv(item.Key)},{item.Value}");
        }
    }

    private static string EscapeCsv(string value)
    {
        return "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }
}

internal static class BenchmarkCommand
{
    public static CommandResult Run(Options options)
    {
        RequireFile(options.InputPath, "--input");
        var outputDirectory = BatchPaths.ResolveRunDirectory(options.OutputDirectory, "csv_benchmark");
        Directory.CreateDirectory(outputDirectory);
        var result = new BenchmarkResult
        {
            Status = "ok",
            InputPath = Path.GetFullPath(options.InputPath),
            InputSizeBytes = new FileInfo(options.InputPath).Length,
            Iterations = options.Iterations,
            OutputDirectory = outputDirectory,
        };

        for (var iteration = 1; iteration <= options.Iterations; iteration++)
        {
            var validateStopwatch = Stopwatch.StartNew();
            var validation = CsvValidator.Validate(options.InputPath, options.MaxExamples);
            validateStopwatch.Stop();
            result.Measurements.Add(BenchmarkMeasurement.From(
                "validate",
                iteration,
                result.InputSizeBytes,
                validateStopwatch.Elapsed.TotalSeconds,
                validation.Status,
                validation.IssueCount));

            var outputPath = Path.Combine(outputDirectory, $"iteration_{iteration:000}_repaired.csv");
            var reportPath = Path.Combine(outputDirectory, $"iteration_{iteration:000}_repair_report.json");
            var fileOptions = options.CloneForFile(options.InputPath, outputPath, reportPath);
            var repairStopwatch = Stopwatch.StartNew();
            var repair = CsvRepairer.Repair(fileOptions);
            repair.Validation = CsvValidator.Validate(outputPath, options.MaxExamples);
            repairStopwatch.Stop();
            result.Measurements.Add(BenchmarkMeasurement.From(
                "repair_validate",
                iteration,
                result.InputSizeBytes,
                repairStopwatch.Elapsed.TotalSeconds,
                repair.Validation.Status,
                repair.TotalRepairChangeCount));
            File.WriteAllText(reportPath, JsonSerializer.Serialize(repair, JsonOutput.Options) + Environment.NewLine, new UTF8Encoding(false));
        }

        result.SummaryJsonPath = Path.Combine(outputDirectory, "benchmark_summary.json");
        File.WriteAllText(result.SummaryJsonPath, JsonSerializer.Serialize(result, JsonOutput.Options) + Environment.NewLine, new UTF8Encoding(false));
        return new CommandResult(0, result);
    }
}

internal static class CsvRepairer
{
    public static RepairResult Repair(Options options, Action<ChangeLogRecord>? onChange = null)
    {
        var inputInfo = new FileInfo(options.InputPath);
        var result = new RepairResult
        {
            InputPath = Path.GetFullPath(options.InputPath),
            OutputPath = options.VisibleOutputPath,
            InputSizeBytes = inputInfo.Length,
            Status = "ok",
        };

        using var reader = new BufferedByteReader(options.InputPath);
        using var output = new FileStream(
            options.OutputPath,
            FileMode.Create,
            FileAccess.Write,
            FileShare.Read,
            bufferSize: 1024 * 1024,
            options: FileOptions.SequentialScan);

        SkipUtf8Bom(reader, result);

        if (options.WriteBom)
        {
            output.WriteByte(0xEF);
            output.WriteByte(0xBB);
            output.WriteByte(0xBF);
        }

        AddBomChangeIfNeeded(options, result, onChange);

        var parser = new RepairParser(options, result, reader, output, onChange);
        parser.Parse();
        output.Flush();

        result.OutputSizeBytes = new FileInfo(options.OutputPath).Length;
        return result;
    }

    private static void SkipUtf8Bom(BufferedByteReader reader, RepairResult result)
    {
        if (reader.Peek(0) == 0xEF && reader.Peek(1) == 0xBB && reader.Peek(2) == 0xBF)
        {
            _ = reader.Read();
            _ = reader.Read();
            _ = reader.Read();
            result.InputHadUtf8Bom = true;
        }
    }

    private static void AddBomChangeIfNeeded(Options options, RepairResult result, Action<ChangeLogRecord>? onChange)
    {
        if (result.InputHadUtf8Bom == options.WriteBom)
        {
            return;
        }

        result.TotalRepairChangeCount++;
        var inputPath = Path.GetFullPath(options.InputPath);
        var outputPath = options.VisibleOutputPath;
        if (result.InputHadUtf8Bom)
        {
            onChange?.Invoke(new ChangeLogRecord
            {
                Path = inputPath,
                OutputPath = outputPath,
                IssueType = "utf8_bom_removed",
                RecordNumber = 0,
                PhysicalLineNumber = 1,
                ByteOffset = 0,
                ColumnNumber = 0,
                OriginalText = "UTF-8 BOM",
                RepairedText = "",
                OriginalBytesHex = "EF BB BF",
                RepairedBytesHex = "",
                OriginalContext = "UTF-8 BOM",
                RepairedContext = "",
                Detail = "input UTF-8 BOM was removed because --write-bom was not set",
            });
            return;
        }

        onChange?.Invoke(new ChangeLogRecord
        {
            Path = inputPath,
            OutputPath = outputPath,
            IssueType = "utf8_bom_added",
            RecordNumber = 0,
            PhysicalLineNumber = 1,
            ByteOffset = 0,
            ColumnNumber = 0,
            OriginalText = "",
            RepairedText = "UTF-8 BOM",
            OriginalBytesHex = "",
            RepairedBytesHex = "EF BB BF",
            OriginalContext = "",
            RepairedContext = "UTF-8 BOM",
            Detail = "UTF-8 BOM was added because --write-bom was set",
        });
    }
}

internal static class InPlaceRepairFiles
{
    public static string CreateTempPath(string inputPath)
    {
        var fullInputPath = Path.GetFullPath(inputPath);
        var directory = Path.GetDirectoryName(fullInputPath) ?? Directory.GetCurrentDirectory();
        var fileName = Path.GetFileName(fullInputPath);
        return Path.Combine(directory, $".{fileName}.{Guid.NewGuid():N}.repair.tmp");
    }

    public static void ReplaceOriginal(string repairedTempPath, string originalPath)
    {
        var fullTempPath = Path.GetFullPath(repairedTempPath);
        var fullOriginalPath = Path.GetFullPath(originalPath);
        var originalAttributes = File.GetAttributes(fullOriginalPath);
        try
        {
            File.Replace(fullTempPath, fullOriginalPath, null, ignoreMetadataErrors: true);
        }
        catch (PlatformNotSupportedException)
        {
            File.Move(fullTempPath, fullOriginalPath, overwrite: true);
        }
        catch (IOException)
        {
            File.Move(fullTempPath, fullOriginalPath, overwrite: true);
        }
        if (File.Exists(fullOriginalPath))
        {
            File.SetAttributes(fullOriginalPath, originalAttributes);
        }
    }

    public static void DeleteIfExists(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // Best-effort cleanup. The original file is never deleted here.
        }
    }
}

internal sealed class RepairParser
{
    private readonly Options options;
    private readonly RepairResult result;
    private readonly BufferedByteReader reader;
    private readonly FileStream output;
    private readonly Action<ChangeLogRecord>? onChange;
    private readonly List<byte[]> fields = [];
    private readonly List<bool> fieldStartedQuoted = [];
    private readonly MemoryStream currentField = new();
    private CsvParseState state = CsvParseState.FieldStart;
    private long physicalLineNumber = 1;
    private long recordNumber = 1;
    private bool currentFieldStartedQuoted;
    private bool currentRecordHasContent;
    private bool headerFinished;
    private bool? autoAllQuoted;
    private int? expectedColumns;

    public RepairParser(Options options, RepairResult result, BufferedByteReader reader, FileStream output, Action<ChangeLogRecord>? onChange)
    {
        this.options = options;
        this.result = result;
        this.reader = reader;
        this.output = output;
        this.onChange = onChange;
        expectedColumns = options.ExpectedColumns;
    }

    public void Parse()
    {
        while (true)
        {
            var offset = reader.NextOffset;
            var value = reader.Read();
            if (value < 0)
            {
                break;
            }

            var byteValue = (byte)value;
            switch (state)
            {
                case CsvParseState.FieldStart:
                    HandleFieldStart(byteValue, offset);
                    break;
                case CsvParseState.InUnquoted:
                    HandleUnquoted(byteValue, offset);
                    break;
                case CsvParseState.InQuoted:
                    HandleQuoted(byteValue, offset);
                    break;
            }
        }

        if (state == CsvParseState.InQuoted)
        {
            AddIssue("unterminated_quoted_field", reader.NextOffset, "file ended while inside a quoted field");
            result.UnterminatedQuotedFieldCount++;
            EndRecord(reader.NextOffset, outputAddsMissingLineEnding: true);
        }
        else if (currentRecordHasContent || fields.Count > 0 || currentField.Length > 0)
        {
            EndRecord(reader.NextOffset, outputAddsMissingLineEnding: true);
        }
    }

    private void HandleFieldStart(byte byteValue, long offset)
    {
        if (byteValue == delimiterByte)
        {
            currentRecordHasContent = true;
            EndField();
            return;
        }

        if (byteValue == quoteByte)
        {
            currentRecordHasContent = true;
            currentFieldStartedQuoted = true;
            state = CsvParseState.InQuoted;
            return;
        }

        if (IsNewline(byteValue))
        {
            var lineEnding = ConsumeLineEnding(byteValue);
            if (currentRecordHasContent || fields.Count > 0 || currentField.Length > 0)
            {
                AddRecordLineEndingChangeIfNeeded(offset, lineEnding);
                EndRecord(offset);
            }
            return;
        }

        currentRecordHasContent = true;
        currentField.WriteByte(byteValue);
        state = CsvParseState.InUnquoted;
    }

    private void HandleUnquoted(byte byteValue, long offset)
    {
        if (byteValue == delimiterByte)
        {
            EndField();
            state = CsvParseState.FieldStart;
            return;
        }

        if (IsNewline(byteValue))
        {
            var lineEnding = ConsumeLineEnding(byteValue);
            AddRecordLineEndingChangeIfNeeded(offset, lineEnding);
            EndRecord(offset);
            return;
        }

        if (byteValue == quoteByte)
        {
            currentField.WriteByte(quoteByte);
            result.RepairedQuoteInsideUnquotedFieldCount++;
            AddRepairChange("quote_inside_unquoted_field", offset, "quote appeared inside an unquoted field and was escaped in output");
            return;
        }

        currentField.WriteByte(byteValue);
    }

    private void HandleQuoted(byte byteValue, long offset)
    {
        if (byteValue == quoteByte)
        {
            HandleQuoteInQuotedField(offset);
            return;
        }

        if (IsNewline(byteValue))
        {
            currentField.WriteByte(lineFeedByte);
            var lineEnding = ConsumeLineEnding(byteValue);
            AddEmbeddedNewlineChangeIfNeeded(offset, lineEnding);
            result.EmbeddedNewlineCount++;
            return;
        }

        currentField.WriteByte(byteValue);
    }

    private void HandleQuoteInQuotedField(long offset)
    {
        var next = reader.Peek(0);
        if (next == quoteByte)
        {
            var afterEscapedQuote = reader.Peek(1);
            if (afterEscapedQuote == delimiterByte && ShouldCloseEscapedTerminalQuoteBeforeDelimiter())
            {
                var issueRecordNumber = recordNumber;
                var issuePhysicalLineNumber = physicalLineNumber;
                var issueColumnNumber = CurrentColumnNumber;
                _ = reader.Read();
                currentField.WriteByte(quoteByte);
                _ = reader.Read();
                EndField();
                state = CsvParseState.FieldStart;
                result.RepairedQuoteBeforeDelimiterCount++;
                AddRepairChange(
                    "escaped_terminal_quote_before_delimiter",
                    offset,
                    "terminal quote before delimiter was kept as data and the field was closed",
                    recordNumberOverride: issueRecordNumber,
                    physicalLineNumberOverride: issuePhysicalLineNumber,
                    columnNumberOverride: issueColumnNumber);
                return;
            }
            if ((afterEscapedQuote == carriageReturnByte || afterEscapedQuote == lineFeedByte) && ShouldCloseEscapedTerminalQuoteBeforeNewline())
            {
                var issueRecordNumber = recordNumber;
                var issuePhysicalLineNumber = physicalLineNumber;
                var issueColumnNumber = CurrentColumnNumber;
                _ = reader.Read();
                currentField.WriteByte(quoteByte);
                var newlineOffset = reader.NextOffset;
                var newline = reader.Read();
                if (newline >= 0)
                {
                    var lineEnding = ConsumeLineEnding((byte)newline);
                    AddRecordLineEndingChangeIfNeeded(newlineOffset, lineEnding);
                }
                EndRecord(offset);
                state = CsvParseState.FieldStart;
                result.RepairedQuoteBeforeNewlineCount++;
                AddRepairChange(
                    "escaped_terminal_quote_before_newline",
                    offset,
                    "terminal quote before newline was kept as data and the record was closed",
                    recordNumberOverride: issueRecordNumber,
                    physicalLineNumberOverride: issuePhysicalLineNumber,
                    columnNumberOverride: issueColumnNumber);
                return;
            }
            _ = reader.Read();
            currentField.WriteByte(quoteByte);
            return;
        }

        if (next == delimiterByte)
        {
            if (ShouldCloseFieldBeforeDelimiter())
            {
                _ = reader.Read();
                EndField();
                state = CsvParseState.FieldStart;
                return;
            }

            currentField.WriteByte(quoteByte);
            result.RepairedQuoteBeforeDelimiterCount++;
            AddRepairChange("quote_before_delimiter_inside_quoted_field", offset, "quote before delimiter was kept inside the current field");
            return;
        }

        if (next == carriageReturnByte || next == lineFeedByte)
        {
            var shouldPadMissingTrailingFields = ShouldPadMissingTrailingFieldsBeforeNewline();
            if (shouldPadMissingTrailingFields || ShouldCloseRecordBeforeNewline())
            {
                var newlineOffset = reader.NextOffset;
                var newline = reader.Read();
                if (newline >= 0)
                {
                    var lineEnding = ConsumeLineEnding((byte)newline);
                    AddRecordLineEndingChangeIfNeeded(newlineOffset, lineEnding);
                }
                EndRecord(offset, padMissingTrailingFields: shouldPadMissingTrailingFields);
                state = CsvParseState.FieldStart;
                return;
            }

            currentField.WriteByte(quoteByte);
            result.RepairedQuoteBeforeNewlineCount++;
            AddRepairChange("quote_before_embedded_newline_inside_quoted_field", offset, "quote before newline was kept inside the current field");
            return;
        }

        if (next < 0)
        {
            if (ShouldPadMissingTrailingFieldsAtEndOfFile())
            {
                EndRecord(offset, outputAddsMissingLineEnding: true, padMissingTrailingFields: true);
                state = CsvParseState.FieldStart;
                return;
            }

            if (expectedColumns is null || CurrentColumnNumber == expectedColumns)
            {
                EndRecord(offset, outputAddsMissingLineEnding: true);
                state = CsvParseState.FieldStart;
                return;
            }
        }

        currentField.WriteByte(quoteByte);
        result.RepairedUnescapedQuoteInsideQuotedFieldCount++;
        AddRepairChange("unescaped_quote_inside_quoted_field", offset, "quote inside a quoted field was escaped in output");
    }

    private bool ShouldCloseFieldBeforeDelimiter()
    {
        if (expectedColumns is not null && CurrentColumnNumber >= expectedColumns.Value)
        {
            return false;
        }

        if (IsAllQuotedActive())
        {
            var afterDelimiter = reader.Peek(1);
            if (afterDelimiter != quoteByte)
            {
                return false;
            }

            return !ShouldKeepDelimiterQuoteInsideLongTextField();
        }

        return true;
    }

    private bool ShouldKeepDelimiterQuoteInsideLongTextField()
    {
        return currentField.Length >= 32 && ClosingHereWouldExceedExpectedColumnsBeforePhysicalLineEnd();
    }

    private bool ClosingHereWouldExceedExpectedColumnsBeforePhysicalLineEnd()
    {
        if (expectedColumns is null)
        {
            return false;
        }

        var expectedSeparatorsRemaining = expectedColumns.Value - CurrentColumnNumber;
        if (expectedSeparatorsRemaining < 0)
        {
            return true;
        }

        var separatorsRemaining = CountAllQuotedSeparatorsBeforePhysicalLineEnd(expectedSeparatorsRemaining + 1);
        return separatorsRemaining > expectedSeparatorsRemaining;
    }

    private int CountAllQuotedSeparatorsBeforePhysicalLineEnd(int stopAfter, int startIndex = 0)
    {
        var separators = 0;
        for (var index = startIndex; ; index++)
        {
            var value = reader.Peek(index);
            if (value < 0 || value == carriageReturnByte || value == lineFeedByte)
            {
                return separators;
            }

            var isCurrentSeparator = index == startIndex && value == delimiterByte && reader.Peek(index + 1) == quoteByte;
            var isLaterSeparator = index > startIndex && value == delimiterByte && reader.Peek(index - 1) == quoteByte && reader.Peek(index + 1) == quoteByte;
            if (isCurrentSeparator || isLaterSeparator)
            {
                separators++;
                if (separators > stopAfter)
                {
                    return separators;
                }
            }
        }
    }

    private bool ShouldCloseEscapedTerminalQuoteBeforeDelimiter()
    {
        if (expectedColumns is not null && CurrentColumnNumber >= expectedColumns.Value)
        {
            return false;
        }

        if (IsAllQuotedActive())
        {
            var afterDelimiter = reader.Peek(2);
            if (afterDelimiter != quoteByte)
            {
                return false;
            }

            return !ClosingHereWouldExceedExpectedColumnsBeforePhysicalLineEnd();
        }

        return true;
    }

    private bool ShouldCloseEscapedTerminalQuoteBeforeNewline()
    {
        if (expectedColumns is not null && CurrentColumnNumber != expectedColumns.Value)
        {
            return false;
        }

        if (!IsAllQuotedActive())
        {
            return true;
        }

        return NextPhysicalLineAfterEscapedTerminalQuoteLooksLikeRecord();
    }

    private bool NextPhysicalLineAfterEscapedTerminalQuoteLooksLikeRecord()
    {
        var startIndex = IndexAfterEscapedTerminalQuoteNewline();
        var first = reader.Peek(startIndex);
        if (first < 0)
        {
            return true;
        }

        if (expectedColumns is null)
        {
            return first == quoteByte;
        }

        return PhysicalLineLooksLikeAllQuotedRecord(startIndex, expectedColumns.Value);
    }

    private int IndexAfterEscapedTerminalQuoteNewline()
    {
        var first = reader.Peek(1);
        if (first == carriageReturnByte && reader.Peek(2) == lineFeedByte)
        {
            return 3;
        }
        return 2;
    }

    private bool PhysicalLineLooksLikeAllQuotedRecord(int startIndex, int columnCount)
    {
        if (reader.Peek(startIndex) != quoteByte)
        {
            return false;
        }

        var separators = CountAllQuotedSeparatorsBeforePhysicalLineEnd(columnCount, startIndex);
        return separators == columnCount - 1;
    }

    private bool ShouldCloseRecordBeforeNewline()
    {
        if (expectedColumns is not null && CurrentColumnNumber != expectedColumns.Value)
        {
            return false;
        }

        if (!IsAllQuotedActive())
        {
            return true;
        }

        var afterNewline = PeekAfterCurrentNewline();
        return afterNewline < 0 || afterNewline == quoteByte;
    }

    private bool ShouldPadMissingTrailingFieldsBeforeNewline()
    {
        if (expectedColumns is null || CurrentColumnNumber >= expectedColumns.Value || !IsAllQuotedActive())
        {
            return false;
        }

        var startIndex = IndexAfterCurrentNewline();
        var first = reader.Peek(startIndex);
        if (first < 0)
        {
            return true;
        }
        if (first != quoteByte)
        {
            return false;
        }

        var separators = CountAllQuotedSeparatorsBeforePhysicalLineEnd(expectedColumns.Value, startIndex);
        return separators == expectedColumns.Value - 1 || separators == CurrentColumnNumber - 1;
    }

    private bool ShouldPadMissingTrailingFieldsAtEndOfFile()
    {
        return expectedColumns is not null
            && CurrentColumnNumber < expectedColumns.Value
            && IsAllQuotedActive();
    }

    private int PeekAfterCurrentNewline()
    {
        return reader.Peek(IndexAfterCurrentNewline());
    }

    private int IndexAfterCurrentNewline()
    {
        var first = reader.Peek(0);
        if (first == carriageReturnByte && reader.Peek(1) == lineFeedByte)
        {
            return 2;
        }
        return 1;
    }

    private bool IsAllQuotedActive()
    {
        return options.AllQuotedMode switch
        {
            AllQuotedMode.True => true,
            AllQuotedMode.False => false,
            _ => autoAllQuoted ?? false,
        };
    }

    private int CurrentColumnNumber => fields.Count + 1;

    private void EndField()
    {
        fields.Add(currentField.ToArray());
        fieldStartedQuoted.Add(currentFieldStartedQuoted);
        currentField.SetLength(0);
        currentFieldStartedQuoted = false;
    }

    private void EndRecord(long offset, bool outputAddsMissingLineEnding = false, bool padMissingTrailingFields = false)
    {
        EndField();

        if (fields.Count == 1 && fields[0].Length == 0 && !currentRecordHasContent)
        {
            ResetRecord();
            return;
        }

        if (!headerFinished)
        {
            if (expectedColumns is null)
            {
                expectedColumns = fields.Count;
            }
            result.ExpectedColumns = expectedColumns;
            result.HeaderColumnCount = fields.Count;
            autoAllQuoted = fieldStartedQuoted.Count == fields.Count && fieldStartedQuoted.All(value => value);
            result.AutoAllQuoted = autoAllQuoted;
            headerFinished = true;
        }
        else if (padMissingTrailingFields && expectedColumns is not null && fields.Count < expectedColumns.Value)
        {
            PadMissingTrailingFields(offset, expectedColumns.Value - fields.Count);
        }
        else if (expectedColumns is not null && fields.Count != expectedColumns.Value)
        {
            result.ColumnMismatchCount++;
            result.Status = "issue";
            AddIssue(
                "column_count_mismatch_after_repair",
                offset,
                $"expected {expectedColumns.Value} columns, got {fields.Count}");
        }

        if (outputAddsMissingLineEnding)
        {
            AddStructuralChange(
                "record_line_ending_added",
                offset,
                "",
                "\n",
                "",
                "0A",
                reader.GetContext(),
                reader.GetContext() + "\\n",
                "output record is terminated with LF while input ended without a record line ending",
                columnNumberOverride: fields.Count);
        }

        WriteRecord(output, fields);
        result.RecordsWrittenIncludingHeader++;
        recordNumber++;
        ResetRecord();
    }

    private void PadMissingTrailingFields(long offset, int missingFieldCount)
    {
        result.PaddedMissingTrailingFieldCount += missingFieldCount;
        AddStructuralChange(
            "missing_trailing_fields_padded",
            offset,
            "",
            string.Join("", Enumerable.Repeat(",\"\"", missingFieldCount)),
            "",
            string.Join(" ", Enumerable.Repeat("2C 22 22", missingFieldCount)),
            reader.GetContext(),
            reader.GetContext(),
            $"record ended with {missingFieldCount} missing trailing field(s); empty fields were appended",
            columnNumberOverride: fields.Count + 1);
        for (var index = 0; index < missingFieldCount; index++)
        {
            fields.Add(Array.Empty<byte>());
            fieldStartedQuoted.Add(true);
        }
    }

    private void ResetRecord()
    {
        fields.Clear();
        fieldStartedQuoted.Clear();
        currentField.SetLength(0);
        currentFieldStartedQuoted = false;
        currentRecordHasContent = false;
        state = CsvParseState.FieldStart;
    }

    private LineEndingInfo ConsumeLineEnding(byte firstNewlineByte)
    {
        var lineNumber = physicalLineNumber;
        if (firstNewlineByte == carriageReturnByte && reader.Peek(0) == lineFeedByte)
        {
            _ = reader.Read();
            physicalLineNumber++;
            return new LineEndingInfo("\r\n", "0D 0A", lineNumber);
        }
        physicalLineNumber++;
        return firstNewlineByte == carriageReturnByte
            ? new LineEndingInfo("\r", "0D", lineNumber)
            : new LineEndingInfo("\n", "0A", lineNumber);
    }

    private void AddEmbeddedNewlineChangeIfNeeded(long offset, LineEndingInfo lineEnding)
    {
        if (lineEnding.Text == "\n")
        {
            return;
        }

        var context = reader.GetContext();
        AddStructuralChange(
            "embedded_newline_normalized",
            offset,
            lineEnding.Text,
            "\n",
            lineEnding.BytesHex,
            "0A",
            context,
            context,
            "embedded newline inside a quoted field was normalized to LF",
            lineEnding.PhysicalLineNumber);
    }

    private void AddRecordLineEndingChangeIfNeeded(long offset, LineEndingInfo lineEnding)
    {
        if (lineEnding.Text == "\n")
        {
            return;
        }

        var context = reader.GetContext();
        AddStructuralChange(
            "record_line_ending_normalized",
            offset,
            lineEnding.Text,
            "\n",
            lineEnding.BytesHex,
            "0A",
            context,
            context,
            "record line ending was normalized to LF",
            lineEnding.PhysicalLineNumber);
    }

    private void AddIssue(string issueType, long offset, string detail)
    {
        if (result.Issues.Count >= options.MaxExamples)
        {
            return;
        }

        result.Issues.Add(new RepairIssue
        {
            IssueType = issueType,
            RecordNumber = recordNumber,
            PhysicalLineNumber = physicalLineNumber,
            ByteOffset = Math.Max(0, offset),
            ColumnNumber = CurrentColumnNumber,
            Detail = detail,
            Snippet = reader.GetContext(),
        });
    }

    private void AddRepairChange(
        string issueType,
        long offset,
        string detail,
        long? recordNumberOverride = null,
        long? physicalLineNumberOverride = null,
        int? columnNumberOverride = null)
    {
        result.TotalRepairChangeCount++;
        var changeRecordNumber = recordNumberOverride ?? recordNumber;
        var changePhysicalLineNumber = physicalLineNumberOverride ?? physicalLineNumber;
        var changeColumnNumber = columnNumberOverride ?? CurrentColumnNumber;
        var context = reader.GetContext();
        var beforeContext = reader.GetBeforeContext();
        var afterContext = reader.GetAfterContext();
        var originalContext = beforeContext + afterContext;
        var repairedContext = ReplaceFinalQuote(beforeContext, "\"\"") + afterContext;
        if (result.Issues.Count < options.MaxExamples)
        {
            result.Issues.Add(new RepairIssue
            {
                IssueType = issueType,
                RecordNumber = changeRecordNumber,
                PhysicalLineNumber = changePhysicalLineNumber,
                ByteOffset = Math.Max(0, offset),
                ColumnNumber = changeColumnNumber,
                Detail = detail,
                Snippet = context,
            });
        }

        onChange?.Invoke(new ChangeLogRecord
        {
            Path = Path.GetFullPath(options.InputPath),
            OutputPath = options.VisibleOutputPath,
            IssueType = issueType,
            RecordNumber = changeRecordNumber,
            PhysicalLineNumber = changePhysicalLineNumber,
            ByteOffset = Math.Max(0, offset),
            ColumnNumber = changeColumnNumber,
            OriginalText = "\"",
            RepairedText = "\"\"",
            OriginalBytesHex = "22",
            RepairedBytesHex = "22 22",
            OriginalContext = originalContext,
            RepairedContext = repairedContext,
            Detail = detail,
        });
    }

    private void AddStructuralChange(
        string issueType,
        long offset,
        string originalText,
        string repairedText,
        string originalBytesHex,
        string repairedBytesHex,
        string originalContext,
        string repairedContext,
        string detail,
        long? physicalLineNumberOverride = null,
        int? columnNumberOverride = null)
    {
        result.TotalRepairChangeCount++;
        onChange?.Invoke(new ChangeLogRecord
        {
            Path = Path.GetFullPath(options.InputPath),
            OutputPath = options.VisibleOutputPath,
            IssueType = issueType,
            RecordNumber = recordNumber,
            PhysicalLineNumber = physicalLineNumberOverride ?? physicalLineNumber,
            ByteOffset = Math.Max(0, offset),
            ColumnNumber = columnNumberOverride ?? CurrentColumnNumber,
            OriginalText = originalText,
            RepairedText = repairedText,
            OriginalBytesHex = originalBytesHex,
            RepairedBytesHex = repairedBytesHex,
            OriginalContext = originalContext,
            RepairedContext = repairedContext,
            Detail = detail,
        });
    }

    private static string ReplaceFinalQuote(string value, string replacement)
    {
        var index = value.LastIndexOf('"');
        return index < 0
            ? value + replacement
            : value[..index] + replacement + value[(index + 1)..];
    }

    private static void WriteRecord(FileStream output, List<byte[]> recordFields)
    {
        for (var index = 0; index < recordFields.Count; index++)
        {
            if (index > 0)
            {
                output.WriteByte(delimiterByte);
            }

            output.WriteByte(quoteByte);
            foreach (var byteValue in recordFields[index])
            {
                if (byteValue == quoteByte)
                {
                    output.WriteByte(quoteByte);
                    output.WriteByte(quoteByte);
                }
                else
                {
                    output.WriteByte(byteValue);
                }
            }
            output.WriteByte(quoteByte);
        }
        output.WriteByte(lineFeedByte);
    }
}

internal readonly record struct LineEndingInfo(string Text, string BytesHex, long PhysicalLineNumber);

internal static class CsvValidator
{
    public static ValidationResult Validate(string path, int maxExamples, Action<RepairIssue>? onIssue = null)
    {
        var stopwatch = Stopwatch.StartNew();
        var result = new ValidationResult
        {
            Path = Path.GetFullPath(path),
            SizeBytes = new FileInfo(path).Length,
            Status = "ok",
        };

        using var reader = new BufferedByteReader(path);
        if (reader.Peek(0) == 0xEF && reader.Peek(1) == 0xBB && reader.Peek(2) == 0xBF)
        {
            _ = reader.Read();
            _ = reader.Read();
            _ = reader.Read();
        }

        var state = CsvParseState.FieldStart;
        long recordNumber = 1;
        long physicalLineNumber = 1;
        long columnNumber = 1;
        long? expectedColumns = null;
        var sawRecordContent = false;

        while (true)
        {
            var offset = reader.NextOffset;
            var value = reader.Read();
            if (value < 0)
            {
                break;
            }

            var byteValue = (byte)value;
            if (state != CsvParseState.InQuoted && IsNewline(byteValue))
            {
                ConsumeLineEnding(reader, byteValue, ref physicalLineNumber);
                EndValidationRecord(result, maxExamples, onIssue, reader, ref expectedColumns, ref recordNumber, physicalLineNumber, offset, columnNumber);
                columnNumber = 1;
                state = CsvParseState.FieldStart;
                sawRecordContent = false;
                continue;
            }

            if (state == CsvParseState.InQuoted && IsNewline(byteValue))
            {
                ConsumeLineEnding(reader, byteValue, ref physicalLineNumber);
                continue;
            }

            switch (state)
            {
                case CsvParseState.FieldStart:
                    sawRecordContent = true;
                    if (byteValue == quoteByte)
                    {
                        state = CsvParseState.InQuoted;
                    }
                    else if (byteValue == delimiterByte)
                    {
                        columnNumber++;
                    }
                    else
                    {
                        state = CsvParseState.InUnquoted;
                    }
                    break;

                case CsvParseState.InUnquoted:
                    if (byteValue == delimiterByte)
                    {
                        columnNumber++;
                        state = CsvParseState.FieldStart;
                    }
                    else if (byteValue == quoteByte)
                    {
                        AddValidationIssue(result, maxExamples, onIssue, reader, "quote_inside_unquoted_field", recordNumber, physicalLineNumber, offset, columnNumber, path);
                    }
                    break;

                case CsvParseState.InQuoted:
                    if (byteValue == quoteByte)
                    {
                        state = CsvParseState.AfterQuote;
                    }
                    break;

                case CsvParseState.AfterQuote:
                    if (byteValue == quoteByte)
                    {
                        state = CsvParseState.InQuoted;
                    }
                    else if (byteValue == delimiterByte)
                    {
                        columnNumber++;
                        state = CsvParseState.FieldStart;
                    }
                    else if (IsNewline(byteValue))
                    {
                        ConsumeLineEnding(reader, byteValue, ref physicalLineNumber);
                        EndValidationRecord(result, maxExamples, onIssue, reader, ref expectedColumns, ref recordNumber, physicalLineNumber, offset, columnNumber);
                        columnNumber = 1;
                        state = CsvParseState.FieldStart;
                        sawRecordContent = false;
                    }
                    else
                    {
                        AddValidationIssue(result, maxExamples, onIssue, reader, "unescaped_quote_inside_quoted_field", recordNumber, physicalLineNumber, offset, columnNumber, path);
                        state = CsvParseState.InQuoted;
                    }
                    break;
            }
        }

        if (state == CsvParseState.InQuoted)
        {
            AddValidationIssue(result, maxExamples, onIssue, reader, "unterminated_quoted_field", recordNumber, physicalLineNumber, reader.NextOffset, columnNumber, path);
        }
        else if (sawRecordContent || columnNumber > 1)
        {
            EndValidationRecord(result, maxExamples, onIssue, reader, ref expectedColumns, ref recordNumber, physicalLineNumber, reader.NextOffset, columnNumber);
        }

        result.ExpectedColumns = expectedColumns;
        result.RecordsScannedIncludingHeader = recordNumber - 1;
        result.PhysicalLinesScanned = physicalLineNumber;
        result.ElapsedSeconds = Math.Round(stopwatch.Elapsed.TotalSeconds, 3);
        result.Status = result.IssueCount == 0 ? "ok" : "issue";
        return result;
    }

    private static void EndValidationRecord(
        ValidationResult result,
        int maxExamples,
        Action<RepairIssue>? onIssue,
        BufferedByteReader reader,
        ref long? expectedColumns,
        ref long recordNumber,
        long physicalLineNumber,
        long offset,
        long columnNumber)
    {
        if (expectedColumns is null)
        {
            expectedColumns = columnNumber;
        }
        else if (columnNumber != expectedColumns.Value)
        {
            AddValidationIssue(
                result,
                maxExamples,
                onIssue,
                reader,
                "column_count_mismatch",
                recordNumber,
                physicalLineNumber,
                offset,
                columnNumber,
                result.Path,
                $"expected {expectedColumns.Value} columns, got {columnNumber}");
        }
        recordNumber++;
    }

    private static void AddValidationIssue(
        ValidationResult result,
        int maxExamples,
        Action<RepairIssue>? onIssue,
        BufferedByteReader reader,
        string issueType,
        long recordNumber,
        long physicalLineNumber,
        long offset,
        long columnNumber,
        string path,
        string? detail = null)
    {
        result.IssueCount++;
        var issue = new RepairIssue
        {
            IssueType = issueType,
            RecordNumber = recordNumber,
            PhysicalLineNumber = physicalLineNumber,
            ByteOffset = Math.Max(0, offset),
            ColumnNumber = columnNumber,
            Detail = detail ?? issueType,
            Snippet = reader.GetContext(),
        };
        onIssue?.Invoke(issue);

        if (result.Issues.Count >= maxExamples)
        {
            return;
        }

        result.Issues.Add(issue);
    }

    private static void ConsumeLineEnding(BufferedByteReader reader, byte firstNewlineByte, ref long physicalLineNumber)
    {
        if (firstNewlineByte == carriageReturnByte && reader.Peek(0) == lineFeedByte)
        {
            _ = reader.Read();
        }
        physicalLineNumber++;
    }
}

internal sealed class BufferedByteReader : IDisposable
{
    private readonly FileStream stream;
    private readonly byte[] buffer = new byte[1024 * 1024];
    private readonly List<int> lookahead = [];
    private readonly Queue<byte> history = new();
    private int position;
    private int length;

    public BufferedByteReader(string path)
    {
        stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            bufferSize: buffer.Length,
            options: FileOptions.SequentialScan);
    }

    public long NextOffset { get; private set; }

    public int Read()
    {
        int value;
        if (lookahead.Count > 0)
        {
            value = lookahead[0];
            lookahead.RemoveAt(0);
        }
        else
        {
            value = ReadRaw();
        }

        if (value >= 0)
        {
            NextOffset++;
            history.Enqueue((byte)value);
            while (history.Count > 512)
            {
                history.Dequeue();
            }
        }
        return value;
    }

    public int Peek(int index)
    {
        while (lookahead.Count <= index)
        {
            var value = ReadRaw();
            if (value < 0)
            {
                return -1;
            }
            lookahead.Add(value);
        }
        return lookahead[index];
    }

    public string GetContext(int radius = 160)
    {
        var bytes = new List<byte>(radius * 2);
        var before = history.TakeLast(radius);
        bytes.AddRange(before);
        for (var index = 0; index < radius; index++)
        {
            var value = Peek(index);
            if (value < 0)
            {
                break;
            }
            bytes.Add((byte)value);
        }
        return DecodeSnippetBytes(bytes.ToArray());
    }

    public string GetBeforeContext(int radius = 120)
    {
        return DecodeSnippetBytes(history.TakeLast(radius).ToArray());
    }

    public string GetAfterContext(int radius = 120)
    {
        var bytes = new List<byte>(radius);
        for (var index = 0; index < radius; index++)
        {
            var value = Peek(index);
            if (value < 0)
            {
                break;
            }
            bytes.Add((byte)value);
        }
        return DecodeSnippetBytes(bytes.ToArray());
    }

    private int ReadRaw()
    {
        if (position >= length)
        {
            length = stream.Read(buffer, 0, buffer.Length);
            position = 0;
            if (length == 0)
            {
                return -1;
            }
        }

        return buffer[position++];
    }

    public void Dispose()
    {
        stream.Dispose();
    }
}

internal static class JsonOutput
{
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true,
    };

    public static readonly JsonSerializerOptions LineOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };
}

internal enum CsvParseState
{
    FieldStart,
    InUnquoted,
    InQuoted,
    AfterQuote,
}

internal enum AllQuotedMode
{
    Auto,
    True,
    False,
}

internal sealed class Options
{
    public string Command { get; private set; } = "repair";
    public string InputPath { get; private set; } = "";
    public string RootPath { get; private set; } = "";
    public string OutputPath { get; private set; } = "";
    public string OutputDirectory { get; private set; } = "";
    public string ReportPath { get; private set; } = "";
    public string IssueLogPath { get; private set; } = "";
    public string ChangeLogPath { get; private set; } = "";
    public List<string> ExcludePatterns { get; private set; } = [];
    public List<string> ExcludeDirectoryPatterns { get; private set; } = [];
    public int? ExpectedColumns { get; private set; }
    public AllQuotedMode AllQuotedMode { get; private set; } = AllQuotedMode.Auto;
    public int MaxExamples { get; private set; } = 20;
    public int Workers { get; private set; } = Math.Max(1, Environment.ProcessorCount - 1);
    public int ProgressEvery { get; private set; } = 100;
    public int Iterations { get; private set; } = 1;
    public bool LogAllIssues { get; private set; }
    public bool LogAllChanges { get; private set; }
    public bool WriteBom { get; private set; }
    public bool ValidateAfterRepair { get; private set; } = true;
    public bool InPlace { get; private set; }
    public bool ShowHelp { get; private set; }
    public bool OutputPathWasDefault { get; private set; }

    public static Options Parse(string[] args)
    {
        var options = new Options();
        var index = 0;
        if (args.Length == 0 || args[0] is "--help" or "-h" or "help")
        {
            options.ShowHelp = true;
            return options;
        }

        if (!args[0].StartsWith("-", StringComparison.Ordinal))
        {
            options.Command = args[0];
            index = 1;
        }

        while (index < args.Length)
        {
            var arg = args[index++];
            switch (arg)
            {
                case "--help":
                case "-h":
                    options.ShowHelp = true;
                    break;
                case "--input":
                    options.InputPath = NeedValue(args, ref index, arg);
                    break;
                case "--root":
                    options.RootPath = NeedValue(args, ref index, arg);
                    break;
                case "--output":
                    options.OutputPath = NeedValue(args, ref index, arg);
                    break;
                case "--output-dir":
                    options.OutputDirectory = NeedValue(args, ref index, arg);
                    break;
                case "--report":
                    options.ReportPath = NeedValue(args, ref index, arg);
                    break;
                case "--issue-log":
                    options.IssueLogPath = NeedValue(args, ref index, arg);
                    options.LogAllIssues = true;
                    break;
                case "--change-log":
                    options.ChangeLogPath = NeedValue(args, ref index, arg);
                    options.LogAllChanges = true;
                    break;
                case "--exclude":
                    options.ExcludePatterns.Add(NeedValue(args, ref index, arg));
                    break;
                case "--exclude-dir":
                    options.ExcludeDirectoryPatterns.Add(NeedValue(args, ref index, arg));
                    break;
                case "--workers":
                    options.Workers = Math.Max(1, int.Parse(NeedValue(args, ref index, arg), CultureInfo.InvariantCulture));
                    break;
                case "--progress-every":
                    options.ProgressEvery = Math.Max(1, int.Parse(NeedValue(args, ref index, arg), CultureInfo.InvariantCulture));
                    break;
                case "--iterations":
                    options.Iterations = Math.Max(1, int.Parse(NeedValue(args, ref index, arg), CultureInfo.InvariantCulture));
                    break;
                case "--expected-columns":
                    options.ExpectedColumns = int.Parse(NeedValue(args, ref index, arg), CultureInfo.InvariantCulture);
                    break;
                case "--all-quoted":
                    options.AllQuotedMode = ParseAllQuotedMode(NeedValue(args, ref index, arg));
                    break;
                case "--max-examples":
                    options.MaxExamples = Math.Max(1, int.Parse(NeedValue(args, ref index, arg), CultureInfo.InvariantCulture));
                    break;
                case "--log-all-issues":
                    options.LogAllIssues = true;
                    break;
                case "--log-all-changes":
                    options.LogAllChanges = true;
                    break;
                case "--in-place":
                    options.InPlace = true;
                    break;
                case "--write-bom":
                    options.WriteBom = true;
                    break;
                case "--no-validate":
                    options.ValidateAfterRepair = false;
                    break;
                default:
                    throw new ArgumentException($"Unknown argument: {arg}");
            }
        }

        return options;
    }

    public Options CloneForFile(string inputPath, string outputPath, string reportPath)
    {
        return new Options
        {
            Command = Command,
            InputPath = inputPath,
            RootPath = RootPath,
            OutputPath = outputPath,
            OutputDirectory = OutputDirectory,
            ReportPath = reportPath,
            IssueLogPath = IssueLogPath,
            ChangeLogPath = ChangeLogPath,
            ExcludePatterns = [.. ExcludePatterns],
            ExcludeDirectoryPatterns = [.. ExcludeDirectoryPatterns],
            ExpectedColumns = ExpectedColumns,
            AllQuotedMode = AllQuotedMode,
            MaxExamples = MaxExamples,
            Workers = Workers,
            ProgressEvery = ProgressEvery,
            Iterations = Iterations,
            LogAllIssues = LogAllIssues,
            LogAllChanges = LogAllChanges,
            WriteBom = WriteBom,
            ValidateAfterRepair = ValidateAfterRepair,
            InPlace = InPlace,
            ShowHelp = ShowHelp,
        };
    }

    public void UseDefaultSingleRepairOutputPath()
    {
        var fullInputPath = Path.GetFullPath(InputPath);
        var directory = Path.GetDirectoryName(fullInputPath) ?? Environment.CurrentDirectory;
        var extension = Path.GetExtension(fullInputPath);
        var outputFileName = $"{Path.GetFileNameWithoutExtension(fullInputPath)}_repaired{extension}";
        OutputPath = Path.Combine(directory, outputFileName);
        OutputPathWasDefault = true;
    }

    public string VisibleOutputPath => Path.GetFullPath(
        InPlace ? InputPath : OutputPath);

    private static string NeedValue(string[] args, ref int index, string optionName)
    {
        if (index >= args.Length)
        {
            throw new ArgumentException($"{optionName} needs a value");
        }
        return args[index++];
    }

    private static AllQuotedMode ParseAllQuotedMode(string value)
    {
        return value.Trim().ToLowerInvariant() switch
        {
            "auto" => AllQuotedMode.Auto,
            "true" or "yes" or "1" => AllQuotedMode.True,
            "false" or "no" or "0" => AllQuotedMode.False,
            _ => throw new ArgumentException("--all-quoted must be auto, true, or false"),
        };
    }
}

internal sealed record CommandResult(int ExitCode, object Payload);

internal sealed class BatchScanResult
{
    public string Status { get; set; } = "ok";
    public int CsvCount { get; set; }
    public long IssueFileCount { get; set; }
    public long TotalIssueCount { get; set; }
    public string OutputDirectory { get; set; } = "";
    public string ProgressPath { get; set; } = "";
    public string SummaryCsvPath { get; set; } = "";
    public string? IssueLogPath { get; set; }
    public double ElapsedSeconds { get; set; }
}

internal sealed class BatchRepairResult
{
    public string Status { get; set; } = "ok";
    public int CsvCount { get; set; }
    public long RepairedFileCount { get; set; }
    public long IssueFileCount { get; set; }
    public long TotalChangeCount { get; set; }
    public string OutputDirectory { get; set; } = "";
    public string ProgressPath { get; set; } = "";
    public string SummaryCsvPath { get; set; } = "";
    public string? ChangeLogPath { get; set; }
    public double ElapsedSeconds { get; set; }
}

internal sealed class AuditResult
{
    public string Status { get; set; } = "ok";
    public long RowCount { get; set; }
    public string OutputDirectory { get; set; } = "";
    public string SummaryJsonPath { get; set; } = "";
    public string SummaryCsvPath { get; set; } = "";
    public Dictionary<string, long> ByPath { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, long> ByIssueType { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, long> ByColumn { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

internal sealed class BenchmarkResult
{
    public string Status { get; set; } = "ok";
    public string InputPath { get; set; } = "";
    public long InputSizeBytes { get; set; }
    public int Iterations { get; set; }
    public string OutputDirectory { get; set; } = "";
    public string SummaryJsonPath { get; set; } = "";
    public List<BenchmarkMeasurement> Measurements { get; set; } = [];
}

internal sealed class BenchmarkMeasurement
{
    public string Phase { get; set; } = "";
    public int Iteration { get; set; }
    public long InputSizeBytes { get; set; }
    public double ElapsedSeconds { get; set; }
    public double MegabytesPerSecond { get; set; }
    public string Status { get; set; } = "";
    public long Count { get; set; }

    public static BenchmarkMeasurement From(string phase, int iteration, long inputSizeBytes, double elapsedSeconds, string status, long count)
    {
        return new BenchmarkMeasurement
        {
            Phase = phase,
            Iteration = iteration,
            InputSizeBytes = inputSizeBytes,
            ElapsedSeconds = Math.Round(elapsedSeconds, 4),
            MegabytesPerSecond = elapsedSeconds <= 0 ? 0 : Math.Round(inputSizeBytes / 1024.0 / 1024.0 / elapsedSeconds, 2),
            Status = status,
            Count = count,
        };
    }
}

internal sealed class RepairResult
{
    public string Status { get; set; } = "ok";
    public string InputPath { get; set; } = "";
    public string OutputPath { get; set; } = "";
    public string ReportPath { get; set; } = "";
    public string ChangeLogPath { get; set; } = "";
    public bool InPlace { get; set; }
    public bool OverwroteInput { get; set; }
    public long InputSizeBytes { get; set; }
    public long OutputSizeBytes { get; set; }
    public bool InputHadUtf8Bom { get; set; }
    public int? ExpectedColumns { get; set; }
    public int HeaderColumnCount { get; set; }
    public bool? AutoAllQuoted { get; set; }
    public long RecordsWrittenIncludingHeader { get; set; }
    public long RepairedUnescapedQuoteInsideQuotedFieldCount { get; set; }
    public long RepairedQuoteBeforeDelimiterCount { get; set; }
    public long RepairedQuoteBeforeNewlineCount { get; set; }
    public long RepairedQuoteInsideUnquotedFieldCount { get; set; }
    public long PaddedMissingTrailingFieldCount { get; set; }
    public long TotalRepairChangeCount { get; set; }
    public long UnterminatedQuotedFieldCount { get; set; }
    public long EmbeddedNewlineCount { get; set; }
    public long ColumnMismatchCount { get; set; }
    public double ElapsedSeconds { get; set; }
    public List<RepairIssue> Issues { get; set; } = [];
    public ValidationResult? Validation { get; set; }
}

internal sealed class ValidationResult
{
    public string Status { get; set; } = "ok";
    public string Path { get; set; } = "";
    public long SizeBytes { get; set; }
    public long? ExpectedColumns { get; set; }
    public long RecordsScannedIncludingHeader { get; set; }
    public long PhysicalLinesScanned { get; set; }
    public long IssueCount { get; set; }
    public double ElapsedSeconds { get; set; }
    public List<RepairIssue> Issues { get; set; } = [];
}

internal sealed class IssueLogRecord
{
    public string Path { get; set; } = "";
    public string IssueType { get; set; } = "";
    public long RecordNumber { get; set; }
    public long PhysicalLineNumber { get; set; }
    public long ByteOffset { get; set; }
    public long ColumnNumber { get; set; }
    public string Detail { get; set; } = "";
    public string Snippet { get; set; } = "";
}

internal sealed class ChangeLogRecord
{
    public string Path { get; set; } = "";
    public string OutputPath { get; set; } = "";
    public string IssueType { get; set; } = "";
    public long RecordNumber { get; set; }
    public long PhysicalLineNumber { get; set; }
    public long ByteOffset { get; set; }
    public long ColumnNumber { get; set; }
    public string OriginalText { get; set; } = "";
    public string RepairedText { get; set; } = "";
    public string OriginalBytesHex { get; set; } = "";
    public string RepairedBytesHex { get; set; } = "";
    public string OriginalContext { get; set; } = "";
    public string RepairedContext { get; set; } = "";
    public string Detail { get; set; } = "";
}

internal sealed class RepairIssue
{
    public string IssueType { get; set; } = "";
    public long RecordNumber { get; set; }
    public long PhysicalLineNumber { get; set; }
    public long ByteOffset { get; set; }
    public long ColumnNumber { get; set; }
    public string Detail { get; set; } = "";
    public string Snippet { get; set; } = "";
}
