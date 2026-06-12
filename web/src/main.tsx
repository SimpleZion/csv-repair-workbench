import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Database,
  FileSearch,
  Gauge,
  Github,
  GitCompare,
  Info,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  Wrench,
} from "lucide-react";
import "./styles.css";

const apiBase = window.localStorage.getItem("csvRepairApiBase") || "http://127.0.0.1:8787";
const githubUrl = "https://github.com/SimpleZion/csv-repair-workbench";

type LocalNetworkRequestInit = RequestInit & { targetAddressSpace?: "loopback" | "local" };

function apiFetch(input: string, init: RequestInit = {}) {
  const nextInit: LocalNetworkRequestInit = { ...init };
  if (isLoopbackUrl(input)) {
    nextInit.targetAddressSpace = "loopback";
  }
  return fetch(input, nextInit);
}

function isLoopbackUrl(input: string) {
  try {
    const url = new URL(input);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1";
  } catch {
    return false;
  }
}

type Command = "scan" | "repair" | "validate" | "audit" | "benchmark";
type Language = "zh" | "en";

const commands: Command[] = ["scan", "repair", "validate", "audit", "benchmark"];

type RunPayload = {
  Status?: string;
  CsvCount?: number;
  IssueFileCount?: number;
  TotalIssueCount?: number;
  TotalChangeCount?: number;
  RepairedFileCount?: number;
  OutputDirectory?: string;
  ProgressPath?: string;
  SummaryCsvPath?: string;
  IssueLogPath?: string;
  ChangeLogPath?: string;
  ExpectedColumns?: number;
  RecordsWrittenIncludingHeader?: number;
  TotalRepairChangeCount?: number;
  RowCount?: number;
  SummaryJsonPath?: string;
  Measurements?: unknown[];
  Validation?: { Status?: string; IssueCount?: number };
};

type RunProgress = {
  path?: string;
  status?: string;
  command?: string;
  csv_count?: number;
  scanned_count?: number;
  repaired_count?: number;
  issue_file_count?: number;
  total_issue_count?: number;
  total_change_count?: number;
  scanned_gb?: number;
  processed_gb?: number;
  elapsed_seconds?: number;
  percent?: number;
};

type RunJob = {
  job_id: string;
  status: string;
  request: Record<string, unknown>;
  command: string[];
  payload?: RunPayload | null;
  progress?: RunProgress | null;
  started_at: string;
  finished_at?: string | null;
  elapsed_seconds?: number | null;
  return_code?: number | null;
  stdout?: string;
  stderr?: string;
};

type JsonlGroup = {
  path: string;
  count: number;
  issue_types?: Record<string, number>;
};

type FormState = {
  command: Command;
  input_path: string;
  root_path: string;
  output_path: string;
  output_dir: string;
  report_path: string;
  issue_log_path: string;
  change_log_path: string;
  exclude: string;
  exclude_dir: string;
  expected_columns: string;
  all_quoted: "auto" | "true" | "false";
  workers: string;
  max_examples: string;
  progress_every: string;
  iterations: string;
  log_all_issues: boolean;
  log_all_changes: boolean;
  validate_after_repair: boolean;
  write_bom: boolean;
};

const defaultForm: FormState = {
  command: "scan",
  input_path: "",
  root_path: "",
  output_path: "",
  output_dir: "outputs\\csv_repair_workbench",
  report_path: "",
  issue_log_path: "",
  change_log_path: "",
  exclude: "",
  exclude_dir: "",
  expected_columns: "",
  all_quoted: "auto",
  workers: "4",
  max_examples: "20",
  progress_every: "25",
  iterations: "1",
  log_all_issues: true,
  log_all_changes: false,
  validate_after_repair: true,
  write_bom: false,
};

const messages = {
  en: {
    tagline: "Streaming repair, full audit logs, strict validation, and batch runs for malformed CSV files.",
    engineReady: "Engine ready",
    runs: "Runs",
    files: "Files",
    artifacts: "Artifacts",
    auditViewer: "Audit viewer",
    refresh: "Refresh",
    runConfiguration: "Run configuration",
    command: "Command",
    required: "required",
    optional: "optional",
    scanHint: "Fill either Input CSV or Root directory. Root directory is for batch scan.",
    repairHint: "Fill Input CSV for one file, or Root directory for batch repair. Output file is only needed for one-file repair.",
    validateHint: "Fill Input CSV. Other output and logging fields are not used.",
    auditHint: "Fill an Issue log file, Change log file, or both. Output directory stores the audit summary.",
    benchmarkHint: "Fill Input CSV. Iterations controls repeated benchmark runs.",
    inputCsv: "Input CSV",
    chooseCsv: "Choose CSV",
    uploadCsv: "Upload CSV",
    uploadingCsv: "Uploading CSV",
    uploadedCsv: "Uploaded and filled Input CSV",
    uploadFailed: "Upload failed",
    uploadCsvHelp: "Choose a local CSV. The workbench uploads it into outputs\\csv_repair_workbench\\uploads and fills this field automatically.",
    rootDirectory: "Root directory",
    outputFile: "Output file",
    outputDirectory: "Output directory",
    reportFile: "Report file",
    issueLogFile: "Issue log file",
    changeLogFile: "Change log file",
    expectedColumns: "Expected columns",
    allQuoted: "All quoted",
    workers: "Workers",
    maxExamples: "Max examples",
    iterations: "Iterations",
    progressEvery: "Progress interval",
    progress: "Progress",
    processed: "Processed",
    total: "Total",
    scannedGb: "Scanned GB",
    processedGb: "Processed GB",
    waitingProgress: "waiting for first progress update",
    reads: "Reads",
    writes: "Writes",
    dataImpact: "Data impact",
    scanLabel: "scan - find issues",
    repairLabel: "repair - write repaired CSV",
    validateLabel: "validate - strict check",
    auditLabel: "audit - summarize logs",
    benchmarkLabel: "benchmark - measure speed",
    scanDescription: "Scans one CSV or a directory tree and records every malformed record that matches the current parser rules.",
    scanReads: "Input CSV or all CSV files under Root directory.",
    scanWrites: "File summary CSV, issue JSONL, progress JSONL, and run summary under Output directory.",
    scanImpact: "Read-only. Source CSV files are not changed.",
    repairDescription: "Repairs one CSV or a directory tree into new files and writes a full change log when enabled.",
    repairReads: "Input CSV for one-file repair, or all CSV files under Root directory for batch repair.",
    repairWrites: "Repaired CSV files, repair reports, change JSONL, progress JSONL, and validation results.",
    repairImpact: "Does not overwrite source files. Writes repaired copies to Output file or Output directory.",
    validateDescription: "Runs strict validation on one CSV and returns whether it is already parser-safe.",
    validateReads: "Input CSV only.",
    validateWrites: "No output files unless you run it through the workbench history.",
    validateImpact: "Read-only. Source CSV files are not changed.",
    auditDescription: "Reads issue/change JSONL logs and creates aggregate counts by file, issue type, and column.",
    auditReads: "Issue log file, Change log file, or both.",
    auditWrites: "Audit summary JSON and CSV under Output directory.",
    auditImpact: "Read-only for CSV data. Only audit summary files are written.",
    benchmarkDescription: "Runs validation and repair repeatedly on one CSV to measure throughput and regression risk.",
    benchmarkReads: "Input CSV only.",
    benchmarkWrites: "Benchmark summary and temporary repaired outputs under Output directory.",
    benchmarkImpact: "Does not overwrite source files. Used for performance testing.",
    inputCsvHelp: "Path to one CSV file. Use this for single-file scan, repair, validate, or benchmark.",
    rootDirectoryHelp: "Directory to scan recursively for CSV files. Use this for batch scan or batch repair.",
    outputFileHelp: "Target repaired CSV path for single-file repair. Leave blank for commands that do not need it.",
    outputDirectoryHelp: "Folder that stores run artifacts. If blank, the workbench writes under outputs\\csv_repair_workbench; each run gets an isolated subfolder.",
    reportFileHelp: "Optional JSON report path for single-file repair.",
    issueLogFileHelp: "For scan, this is the optional path to write issue JSONL. For audit, this is an existing issue JSONL to summarize.",
    changeLogFileHelp: "For repair, this is the optional path to write change JSONL. For audit, this is an existing change JSONL to summarize.",
    expectedColumnsHelp: "Leave blank for auto-detection, or enter a fixed column count when the schema is known.",
    allQuotedHelp: "auto lets the engine infer whether every field should be quoted; true/false forces that rule.",
    workersHelp: "Parallel file workers for directory scan/repair. Higher is faster but uses more CPU and disk IO.",
    maxExamplesHelp: "Maximum detailed example issues kept in each report. Full logs are controlled by the log switches.",
    iterationsHelp: "Number of repeated benchmark runs.",
    progressEveryHelp: "Write a progress update after this many files. Lower values make progress more granular.",
    excludeFilesHelp: "One pattern per line. Matches file names or paths, for example temporary exports or backup CSVs.",
    excludeDirectoriesHelp: "One pattern per line. Skips matching subdirectories during recursive batch scan/repair.",
    inputCsvExample: "samples\\malformed.csv",
    rootDirectoryExample: "D:\\Data\\csv_exports",
    outputFileExample: "outputs\\csv_repair_workbench\\malformed_repaired.csv",
    outputDirectoryExample: "outputs\\csv_repair_workbench",
    reportFileExample: "outputs\\csv_repair_workbench\\repair_report.json",
    issueLogFileExample: "outputs\\csv_repair_workbench\\issues.jsonl",
    changeLogFileExample: "outputs\\csv_repair_workbench\\changes.jsonl",
    expectedColumnsExample: "auto or 9",
    excludeFilesExample: "**\\backup\\*.csv\n*TEMPLATE*.csv",
    excludeDirectoriesExample: "**\\.git\n**\\raw_backup\n**\\temp",
    viewRunArtifacts: "Task results",
    viewIssues: "Issue files and repair",
    viewIssuesHint: "Groups issues by CSV file. Open a file to inspect records or start single-file or batch repair.",
    viewChanges: "Repair diff",
    viewChangesHint: "Compares original and repaired context, with changed characters highlighted.",
    viewProgress: "Batch progress",
    viewProgressHint: "Shows processed files, task status, byte volume and interruption point.",
    viewSummary: "Engine summary",
    viewSummaryHint: "Displays the complete JSON result returned by the repair engine.",
    noRunArtifacts: "This run has no previewable artifacts yet.",
    details: "Details",
    preview: "Preview",
    closePreview: "Close preview",
    closeDetails: "Close details",
    back: "Back",
    fileGroups: "Files with issues",
    fileGroupHint: "Issue logs open as a file list first. Select one file to inspect its issue rows.",
    currentFileIssues: "Current file issues",
    repairPreviewChanges: "Repair change preview",
    previewRepairChanges: "Instant repair preview",
    previewRepairChangesHint: "Builds a fast before/after preview from the current scan rows without rewriting the CSV.",
    previewRepairBusy: "Building preview",
    showFileIssues: "View issues",
    issueTypeSummary: "Issue types",
    repairThisFile: "Repair file",
    repairAllIssueFiles: "Repair all issue files",
    repairJobsStarted: "Repair jobs started",
    advancedSettings: "Advanced settings",
    previousPage: "Previous",
    nextPage: "Next",
    doubleClickDetails: "Double-click a run to open details in a modal without leaving this view.",
    requestPayload: "Request payload",
    enginePayload: "Engine payload",
    engineCommand: "Engine command",
    stdout: "stdout",
    stderr: "stderr",
    repairSelectedFile: "Repair selected file",
    repairScanScope: "Repair this scan scope",
    repairActions: "Repair actions",
    selectedFileMissing: "Select an issue/change row that contains a Path field first.",
    localApiBlocked: "The hosted UI needs access to the local API at 127.0.0.1:8787. If the browser asks for local network access, allow it.",
    reconnectLocalApi: "Reconnect local API",
    excludeFiles: "Exclude files or path globs",
    excludeDirectories: "Exclude directories",
    logIssues: "Log issues",
    logChanges: "Log changes",
    writeBom: "Write BOM",
    validate: "Validate",
    startRun: "Start run",
    status: "Status",
    started: "Started",
    elapsed: "Elapsed",
    issueFiles: "Issue files",
    changes: "Changes",
    outputDir: "Output directory",
    summaryJson: "Summary JSON",
    summaryCsv: "File summary table",
    summaryCsvHint: "Tabular view of each CSV file's scan or repair result.",
    progressJsonl: "Progress JSONL",
    issuesJsonl: "Issues JSONL",
    changesJsonl: "Changes JSONL",
    openPreview: "Open preview",
    notAvailable: "not available",
    noRun: "No run selected.",
    openArtifact: "Open an issue, change, or progress JSONL artifact to preview rows here.",
    issueInspector: "Issue inspector",
    run: "Run",
    issue: "Issue",
    record: "Record",
    column: "Column",
    byteOffset: "Byte offset",
    originalContext: "Original context",
    repairedContext: "Repaired context",
    beforeToken: "Before",
    afterToken: "After",
    projectedPreview: "Projected repair",
    repairedContextMissing: "Only repair change logs include repaired context.",
    openJsonlFirst: "Open a JSONL artifact and select a row.",
    originalBytes: "Original bytes",
    repairedBytes: "Repaired bytes",
    runStatus: "Run status",
    csvFiles: "CSV files",
    validation: "Validation",
    idle: "idle",
    language: "中文",
  },
  zh: {
    tagline: "面向异常 CSV 的流式修复、全量审计、严格验证和批量任务工作台。",
    engineReady: "引擎就绪",
    runs: "运行",
    files: "文件",
    artifacts: "产物",
    auditViewer: "审计查看",
    refresh: "刷新",
    runConfiguration: "任务配置",
    command: "命令",
    required: "必填",
    optional: "可选",
    scanHint: "填写“输入 CSV”或“根目录”即可；根目录用于批量扫描。",
    repairHint: "单文件修复填“输入 CSV”，批量修复填“根目录”；“输出文件”只用于单文件修复。",
    validateHint: "只需要填写“输入 CSV”；输出和日志字段不会被使用。",
    auditHint: "填写“问题日志文件”或“修改日志文件”，也可以两个都填；输出目录用于保存审计汇总。",
    benchmarkHint: "填写“输入 CSV”；迭代次数用于重复跑性能测试。",
    inputCsv: "输入 CSV",
    chooseCsv: "选择 CSV",
    uploadCsv: "上传 CSV",
    uploadingCsv: "正在上传 CSV",
    uploadedCsv: "已上传并填入输入 CSV",
    uploadFailed: "上传失败",
    uploadCsvHelp: "选择本地 CSV 后，工作台会上传到 outputs\\csv_repair_workbench\\uploads，并自动填入这个字段。",
    rootDirectory: "根目录",
    outputFile: "输出文件",
    outputDirectory: "输出目录",
    reportFile: "报告文件",
    issueLogFile: "问题日志文件",
    changeLogFile: "修改日志文件",
    expectedColumns: "预期列数",
    allQuoted: "全字段引号",
    workers: "并行数",
    maxExamples: "样例上限",
    iterations: "迭代次数",
    progressEvery: "进度间隔",
    excludeFiles: "排除文件或路径通配",
    excludeDirectories: "排除子目录",
    logIssues: "记录问题",
    logChanges: "记录修改",
    writeBom: "写入 BOM",
    validate: "验证",
    startRun: "启动任务",
    status: "状态",
    started: "开始时间",
    elapsed: "耗时",
    issueFiles: "问题文件",
    changes: "修改点",
    outputDir: "输出目录",
    summaryJson: "汇总 JSON",
    summaryCsv: "文件汇总表",
    summaryCsvHint: "以表格方式呈现每个 CSV 的扫描或修复结果。",
    progressJsonl: "进度 JSONL",
    issuesJsonl: "问题 JSONL",
    changesJsonl: "修改 JSONL",
    openPreview: "打开预览",
    notAvailable: "不可用",
    noRun: "尚未选择任务。",
    openArtifact: "打开问题、修改或进度 JSONL 后，这里会显示预览行。",
    issueInspector: "问题检查器",
    run: "任务",
    issue: "问题",
    record: "记录",
    column: "列",
    byteOffset: "字节偏移",
    originalContext: "原始上下文",
    repairedContext: "修复后上下文",
    beforeToken: "修改前",
    afterToken: "修改后",
    projectedPreview: "预计修复",
    repairedContextMissing: "只有修复修改日志包含修复后上下文。",
    openJsonlFirst: "请先打开 JSONL 产物并选择一行。",
    originalBytes: "原始字节",
    repairedBytes: "修复后字节",
    runStatus: "任务状态",
    csvFiles: "CSV 文件",
    validation: "验证",
    idle: "空闲",
    progress: "进度",
    processed: "已处理",
    total: "总数",
    scannedGb: "已扫描 GB",
    processedGb: "已处理 GB",
    waitingProgress: "等待首次进度更新",
    reads: "读取",
    writes: "产出",
    dataImpact: "数据影响",
    scanLabel: "scan - 扫描问题",
    repairLabel: "repair - 生成修复版 CSV",
    validateLabel: "validate - 严格验证",
    auditLabel: "audit - 汇总日志",
    benchmarkLabel: "benchmark - 性能测试",
    scanDescription: "扫描一个 CSV 或一个目录下的所有 CSV，找出引号、换行、列数等解析异常。",
    scanReads: "读取“输入 CSV”或“根目录”下的所有 CSV。",
    scanWrites: "在输出目录写入文件汇总 CSV、问题 JSONL、进度 JSONL 和任务记录。",
    scanImpact: "只读，不修改原始 CSV。",
    repairDescription: "把异常 CSV 修复为新的 CSV 文件，可记录每个修改点并在修复后再次验证。",
    repairReads: "单文件修复读取“输入 CSV”；批量修复读取“根目录”下的所有 CSV。",
    repairWrites: "写入修复后的 CSV、修复报告、修改 JSONL、进度 JSONL 和验证结果。",
    repairImpact: "不覆盖原始 CSV；修复结果写到“输出文件”或“输出目录”。",
    validateDescription: "对单个 CSV 做严格解析验证，判断它是否已经能被稳定读取。",
    validateReads: "只读取“输入 CSV”。",
    validateWrites: "不写业务产物，只保留工作台运行历史。",
    validateImpact: "只读，不修改原始 CSV。",
    auditDescription: "读取 scan/repair 产生的问题或修改日志，按文件、问题类型、列号做汇总。",
    auditReads: "读取“问题日志文件”“修改日志文件”中的一个或两个。",
    auditWrites: "在输出目录写入审计汇总 JSON 和 CSV。",
    auditImpact: "不修改 CSV，只写审计汇总文件。",
    benchmarkDescription: "对单个 CSV 重复执行验证和修复，用于评估吞吐、回归风险和参数影响。",
    benchmarkReads: "只读取“输入 CSV”。",
    benchmarkWrites: "在输出目录写入性能汇总和临时修复输出。",
    benchmarkImpact: "不覆盖原始 CSV，只用于性能测试。",
    inputCsvHelp: "用于指定一个 CSV 文件路径。单文件扫描、修复、验证和性能测试都用这个字段。",
    rootDirectoryHelp: "用于指定批量任务的根目录，系统会递归查找其中的 CSV 文件。",
    outputFileHelp: "用于指定单文件 repair 的修复后 CSV 路径；批量任务不需要填。",
    outputDirectoryHelp: "用于指定本次任务产物保存在哪个文件夹。不填时自动保存到工作区 outputs\\csv_repair_workbench；每次运行会自动创建独立子目录。",
    reportFileHelp: "用于指定单文件 repair 的 JSON 报告路径；不填也可以。",
    issueLogFileHelp: "scan 时用于指定问题 JSONL 的写入位置；audit 时用于指定已有问题 JSONL 的读取位置。",
    changeLogFileHelp: "repair 时用于指定修改 JSONL 的写入位置；audit 时用于指定已有修改 JSONL 的读取位置。",
    expectedColumnsHelp: "用于指定固定列数。留空表示自动从表头推断；已知 schema 时可填具体数字。",
    allQuotedHelp: "用于指定是否要求所有字段都有引号。auto 表示自动判断；true/false 表示强制规则。",
    workersHelp: "用于指定目录扫描/修复的并行文件数。数值越高通常越快，但会增加 CPU 和磁盘 IO。",
    maxExamplesHelp: "用于指定每个报告中保留的详细样例数量；完整日志由记录开关控制。",
    iterationsHelp: "用于指定 benchmark 重复运行次数。",
    progressEveryHelp: "用于指定处理多少个文件写一次进度。数值越小，进度显示越细。",
    excludeFilesHelp: "用于指定要排除的文件名或路径通配模式，一行一个。",
    excludeDirectoriesHelp: "用于指定递归批量任务中要跳过的子目录，一行一个。",
    inputCsvExample: "samples\\malformed.csv",
    rootDirectoryExample: "D:\\Data\\csv_exports",
    outputFileExample: "outputs\\csv_repair_workbench\\malformed_repaired.csv",
    outputDirectoryExample: "outputs\\csv_repair_workbench",
    reportFileExample: "outputs\\csv_repair_workbench\\repair_report.json",
    issueLogFileExample: "outputs\\csv_repair_workbench\\issues.jsonl",
    changeLogFileExample: "outputs\\csv_repair_workbench\\changes.jsonl",
    expectedColumnsExample: "auto 或 9",
    excludeFilesExample: "**\\backup\\*.csv\n*TEMPLATE*.csv",
    excludeDirectoriesExample: "**\\.git\n**\\raw_backup\n**\\temp",
    viewRunArtifacts: "任务结果",
    viewIssues: "问题文件与修复",
    viewIssuesHint: "按 CSV 文件维度归集问题；进入文件后可查看异常记录，并可发起单文件或批量修复。",
    viewChanges: "修复差异对比",
    viewChangesHint: "对比原始上下文与修复后上下文，并高亮实际变更。",
    viewProgress: "批量处理进度",
    viewProgressHint: "展示已处理文件数、任务状态、字节量及中断位置。",
    viewSummary: "引擎结果摘要",
    viewSummaryHint: "展示修复引擎返回的完整 JSON 结果。",
    noRunArtifacts: "当前任务还没有可预览产物。",
    details: "详情",
    preview: "预览",
    closePreview: "关闭预览",
    closeDetails: "关闭详情",
    back: "返回",
    fileGroups: "问题文件",
    fileGroupHint: "问题日志会先按文件分组。选择某个文件后，再查看该文件的具体问题行。",
    currentFileIssues: "当前文件问题",
    repairPreviewChanges: "修复修改预览",
    previewRepairChanges: "即时预览修复点",
    previewRepairChangesHint: "基于当前扫描结果立即生成修复前后对比，不重写完整 CSV。",
    previewRepairBusy: "正在生成预览",
    showFileIssues: "查看问题",
    issueTypeSummary: "问题类型",
    repairThisFile: "修复此文件",
    repairAllIssueFiles: "修复全部问题文件",
    repairJobsStarted: "已启动修复任务",
    advancedSettings: "高级参数",
    previousPage: "上一页",
    nextPage: "下一页",
    doubleClickDetails: "双击任务行可弹窗查看完整详情，不会离开当前视图。",
    requestPayload: "请求参数",
    enginePayload: "引擎结果",
    engineCommand: "引擎命令",
    stdout: "stdout",
    stderr: "stderr",
    repairSelectedFile: "修复当前文件",
    repairScanScope: "修复本次扫描范围",
    repairActions: "修复操作",
    selectedFileMissing: "请先选择一行包含 Path 字段的问题或修改记录。",
    localApiBlocked: "线上 UI 需要访问本机 127.0.0.1:8787 API。浏览器如果弹出本地网络访问授权，请选择允许。",
    reconnectLocalApi: "重新连接本地 API",
    language: "English",
  },
} satisfies Record<Language, Record<string, string>>;

function App() {
  const [form, setForm] = useState<FormState>(loadInitialForm);
  const [runs, setRuns] = useState<RunJob[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [activeTab, setActiveTab] = useState("runs");
  const [language, setLanguage] = useState<Language>(() => (window.localStorage.getItem("csvRepairLanguage") as Language) || "zh");
  const [viewerRows, setViewerRows] = useState<unknown[]>([]);
  const [selectedAuditIndex, setSelectedAuditIndex] = useState(0);
  const [viewerPath, setViewerPath] = useState("");
  const [viewerKind, setViewerKind] = useState<"jsonl" | "text" | "csv" | "report" | "">("");
  const [viewerColumns, setViewerColumns] = useState<string[]>([]);
  const [viewerOffset, setViewerOffset] = useState(0);
  const [viewerNextOffset, setViewerNextOffset] = useState(0);
  const [viewerHasMore, setViewerHasMore] = useState(false);
  const [viewerGroups, setViewerGroups] = useState<JsonlGroup[]>([]);
  const [viewerPathFilter, setViewerPathFilter] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");
  const [previewingRepairPath, setPreviewingRepairPath] = useState("");
  const [apiConnectionError, setApiConnectionError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedRun = runs.find((run) => run.job_id === selectedRunId) ?? runs[0];
  const text = messages[language];
  const metrics = useMemo(() => buildMetrics(selectedRun, text), [selectedRun, text]);
  const fields = commandFields(form.command);

  useEffect(() => {
    void refreshRuns();
    const timer = window.setInterval(refreshRuns, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("csvRepairWorkbenchForm", JSON.stringify(form));
  }, [form]);

  function toggleLanguage() {
    const nextLanguage = language === "zh" ? "en" : "zh";
    setLanguage(nextLanguage);
    window.localStorage.setItem("csvRepairLanguage", nextLanguage);
  }

  function switchTab(tab: string) {
    setPreviewOpen(false);
    setDetailsOpen(false);
    setActiveTab(tab);
  }

  async function refreshRuns() {
    try {
      const response = await apiFetch(`${apiBase}/api/runs`);
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = await response.json();
      setRuns(payload.runs ?? []);
      setApiConnectionError("");
    } catch (error) {
      setApiConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectRun(jobId: string) {
    setSelectedRunId(jobId);
  }

  async function openRunDetails(run: RunJob) {
    setSelectedRunId(run.job_id);
    setPreviewOpen(false);
    setDetailsOpen(true);
  }

  async function submitRun(event: React.FormEvent) {
    event.preventDefault();
    await startRun(buildRunBody());
  }

  function buildRunBody(overrides: Record<string, unknown> = {}) {
    return {
      command: form.command,
      input_path: form.input_path.trim(),
      root_path: form.root_path.trim(),
      output_path: form.output_path.trim(),
      output_dir: form.output_dir.trim(),
      report_path: form.report_path.trim(),
      issue_log_path: form.issue_log_path.trim(),
      change_log_path: form.change_log_path.trim(),
      exclude: splitLines(form.exclude),
      exclude_dir: splitLines(form.exclude_dir),
      expected_columns: expectedColumnsValue(form.expected_columns),
      all_quoted: form.all_quoted,
      workers: positiveIntegerValue(form.workers, 4),
      max_examples: positiveIntegerValue(form.max_examples, 20),
      progress_every: positiveIntegerValue(form.progress_every, 25),
      iterations: positiveIntegerValue(form.iterations, 1),
      log_all_issues: form.log_all_issues,
      log_all_changes: form.log_all_changes,
      validate_after_repair: form.validate_after_repair,
      write_bom: form.write_bom,
      ...overrides,
    };
  }

  async function startRun(body: Record<string, unknown>) {
    const response = await apiFetch(`${apiBase}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setViewerRows([{ error: await response.text() }]);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const payload = await response.json();
    if (payload.job?.job_id) {
      setSelectedRunId(payload.job.job_id);
    }
    await refreshRuns();
  }

  function chooseInputCsv() {
    fileInputRef.current?.click();
  }

  function handleInputCsvFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      void uploadInputCsv(file);
    }
  }

  async function uploadInputCsv(file: File) {
    setUploadProgress(null);
    setUploadMessage(`${text.uploadingCsv}: ${file.name}`);
    try {
      const payload = await uploadCsvFile(file);
      setForm((previous) => ({
        ...previous,
        input_path: String(payload.path ?? ""),
        root_path: "",
      }));
      setUploadProgress(100);
      setUploadMessage(`${text.uploadedCsv}: ${formatBytes(Number(payload.size_bytes ?? file.size))}`);
    } catch (error) {
      setUploadProgress(null);
      setUploadMessage(`${text.uploadFailed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function uploadCsvFile(file: File): Promise<Record<string, unknown>> {
    const response = await apiFetch(`${apiBase}/api/uploads/csv?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: file,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return await response.json();
  }

  async function repairSelectedFile(row: unknown) {
    const path = getRecordPath(row);
    if (!path) {
      setViewerRows([{ message: text.selectedFileMissing }]);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    await startRun(buildRepairBodyFromRun(selectedRun, {
      input_path: path,
      root_path: "",
      output_path: "",
      report_path: "",
      change_log_path: "",
    }));
  }

  async function repairIssueFile(path: string) {
    if (!path) {
      return;
    }
    await startRun(buildRepairBodyFromRun(selectedRun, {
      input_path: path,
      root_path: "",
      output_path: "",
      report_path: "",
      change_log_path: "",
    }));
  }

  async function previewRepairIssueFile(path: string) {
    if (!path || previewingRepairPath) {
      return;
    }
    setPreviewingRepairPath(path);
    try {
      const previewLimit = positiveIntegerValue(form.max_examples, 20);
      let sourceRows = rowsForPath(viewerRows, path);
      if (sourceRows.length === 0 && viewerPath) {
        const response = await apiFetch(`${apiBase}/api/jsonl?path=${encodeURIComponent(viewerPath)}&limit=${previewLimit}&offset=0&path_filter=${encodeURIComponent(path)}`);
        if (!response.ok) {
          setViewerRows([{ error: await response.text(), path }]);
          setViewerGroups([]);
          setViewerPathFilter(path);
          setSelectedAuditIndex(0);
          setPreviewOpen(true);
          return;
        }
        const payload = await response.json();
        sourceRows = payload.rows ?? [];
      }
      const previewRows = projectRepairPreviewRows(sourceRows, previewLimit);
      setViewerRows(previewRows.length > 0 ? previewRows : [{ message: text.openArtifact, path }]);
      setViewerPath(viewerPath || path);
      setViewerKind("jsonl");
      setViewerColumns([]);
      setViewerGroups([{ path, count: previewRows.length, issue_types: {} }]);
      setViewerPathFilter(path);
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
    } finally {
      setPreviewingRepairPath("");
    }
  }

  async function repairIssueFiles(groups: JsonlGroup[]) {
    const paths = groups.map((group) => group.path).filter(Boolean);
    for (const path of paths) {
      await startRun(buildRepairBodyFromRun(selectedRun, {
        input_path: path,
        root_path: "",
        output_path: "",
        report_path: "",
        change_log_path: "",
      }));
    }
    setViewerRows([{ message: `${text.repairJobsStarted}: ${paths.length}` }]);
    setViewerGroups([]);
    setViewerPathFilter("");
    setSelectedAuditIndex(0);
    setPreviewOpen(true);
  }

  async function repairCurrentScanScope(run?: RunJob) {
    if (!run || run.request?.command !== "scan") {
      return;
    }
    await startRun(buildRepairBodyFromRun(run));
  }

  function buildRepairBodyFromRun(run?: RunJob, overrides: Record<string, unknown> = {}) {
    const request = run?.request ?? {};
    return buildRunBody({
      command: "repair",
      input_path: stringValue(request.input_path),
      root_path: stringValue(request.root_path),
      output_path: "",
      report_path: "",
      issue_log_path: "",
      change_log_path: "",
      output_dir: stringValue(request.output_dir) || form.output_dir.trim(),
      exclude: listValue(request.exclude),
      exclude_dir: listValue(request.exclude_dir),
      expected_columns: nullableNumberValue(request.expected_columns),
      all_quoted: allQuotedValue(request.all_quoted),
      workers: numberValue(request.workers, positiveIntegerValue(form.workers, 4)),
      max_examples: numberValue(request.max_examples, positiveIntegerValue(form.max_examples, 20)),
      progress_every: numberValue(request.progress_every, positiveIntegerValue(form.progress_every, 25)),
      log_all_issues: false,
      log_all_changes: true,
      validate_after_repair: true,
      ...overrides,
    });
  }

  async function loadJsonl(path?: string, offset = 0, pathFilter = "") {
    if (!path) {
      setViewerRows([]);
      setViewerPath("");
      setViewerKind("");
      setViewerColumns([]);
      setViewerGroups([]);
      setViewerPathFilter("");
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setPreviewOpen(false);
      return;
    }
    const groupsResponse = await apiFetch(`${apiBase}/api/jsonl/groups?path=${encodeURIComponent(path)}`);
    const groupsPayload = groupsResponse.ok ? await groupsResponse.json() : { groups: [] };
    const groups = (groupsPayload.groups ?? []) as JsonlGroup[];
    if (groups.length > 0 && !pathFilter) {
      setViewerRows([]);
      setViewerPath(path);
      setViewerKind("jsonl");
      setViewerColumns([]);
      setViewerGroups(groups);
      setViewerPathFilter("");
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const filterQuery = pathFilter ? `&path_filter=${encodeURIComponent(pathFilter)}` : "";
    const response = await apiFetch(`${apiBase}/api/jsonl?path=${encodeURIComponent(path)}&limit=200&offset=${offset}${filterQuery}`);
    if (!response.ok) {
      setViewerRows([{ error: await response.text(), path }]);
      setViewerGroups(groups);
      setViewerPathFilter(pathFilter);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const payload = await response.json();
    setViewerRows(payload.rows ?? []);
    setViewerPath(path);
    setViewerKind("jsonl");
    setViewerColumns([]);
    setViewerGroups(groups);
    setViewerPathFilter(pathFilter);
    setViewerOffset(payload.offset ?? offset);
    setViewerNextOffset(payload.next_offset ?? offset);
    setViewerHasMore(Boolean(payload.has_more));
    setSelectedAuditIndex(0);
    setPreviewOpen(true);
  }

  async function loadReport(path?: string) {
    if (!path) {
      setViewerRows([]);
      setViewerPath("");
      setViewerKind("");
      setViewerColumns([]);
      setViewerGroups([]);
      setViewerPathFilter("");
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setPreviewOpen(false);
      return;
    }
    const response = await apiFetch(`${apiBase}/api/report?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      setViewerRows([{ error: await response.text(), path }]);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const payload = await response.json();
    setViewerRows([payload]);
    setViewerPath(path);
    setViewerKind("report");
    setViewerColumns([]);
    setViewerGroups([]);
    setViewerPathFilter("");
    setViewerOffset(0);
    setViewerNextOffset(0);
    setViewerHasMore(false);
    setSelectedAuditIndex(0);
    setPreviewOpen(true);
  }

  async function loadText(path?: string, offset = 0) {
    if (!path) {
      setViewerRows([]);
      setViewerPath("");
      setViewerKind("");
      setViewerColumns([]);
      setViewerGroups([]);
      setViewerPathFilter("");
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setPreviewOpen(false);
      return;
    }
    const response = await apiFetch(`${apiBase}/api/text?path=${encodeURIComponent(path)}&limit=200&offset=${offset}`);
    if (!response.ok) {
      setViewerRows([{ error: await response.text(), path }]);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const payload = await response.json();
    setViewerRows(payload.rows ?? []);
    setViewerPath(path);
    setViewerKind("text");
    setViewerColumns([]);
    setViewerGroups([]);
    setViewerPathFilter("");
    setViewerOffset(payload.offset ?? offset);
    setViewerNextOffset(payload.next_offset ?? offset);
    setViewerHasMore(Boolean(payload.has_more));
    setSelectedAuditIndex(0);
    setPreviewOpen(true);
  }

  async function loadCsv(path?: string, offset = 0) {
    if (!path) {
      setViewerRows([]);
      setViewerPath("");
      setViewerKind("");
      setViewerColumns([]);
      setViewerGroups([]);
      setViewerPathFilter("");
      setViewerOffset(0);
      setViewerNextOffset(0);
      setViewerHasMore(false);
      setPreviewOpen(false);
      return;
    }
    const response = await apiFetch(`${apiBase}/api/csv?path=${encodeURIComponent(path)}&limit=200&offset=${offset}`);
    if (!response.ok) {
      setViewerRows([{ error: await response.text(), path }]);
      setSelectedAuditIndex(0);
      setPreviewOpen(true);
      return;
    }
    const payload = await response.json();
    setViewerRows(payload.rows ?? []);
    setViewerColumns(payload.columns ?? []);
    setViewerPath(path);
    setViewerKind("csv");
    setViewerGroups([]);
    setViewerPathFilter("");
    setViewerOffset(payload.offset ?? offset);
    setViewerNextOffset(payload.next_offset ?? offset);
    setViewerHasMore(Boolean(payload.has_more));
    setSelectedAuditIndex(0);
    setPreviewOpen(true);
  }

  async function loadViewerPage(offset: number) {
    if (!viewerPath || viewerKind === "report") {
      return;
    }
    if (viewerKind === "csv") {
      await loadCsv(viewerPath, offset);
      return;
    }
    if (viewerKind === "text") {
      await loadText(viewerPath, offset);
      return;
    }
    await loadJsonl(viewerPath, offset, viewerPathFilter);
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="top-bar">
          <div>
            <h1>CsvRepairWorkbench</h1>
            <p>{text.tagline}</p>
          </div>
          <div className="top-actions">
            <a className="github-link" href={githubUrl} target="_blank" rel="noreferrer" aria-label="GitHub">
              <Github size={17} />
              GitHub
            </a>
            <button className="language-toggle" type="button" onClick={toggleLanguage}>{text.language}</button>
            <div className="health-chip">
              <ShieldCheck size={18} />
              {text.engineReady}
            </div>
          </div>
        </header>

        <section className="metric-strip">
          {metrics.map((metric) => (
            <div className="metric" key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </div>
          ))}
        </section>
        {apiConnectionError && (
          <section className="api-warning">
            <div>
              <strong>{text.localApiBlocked}</strong>
              <span>{apiConnectionError}</span>
            </div>
            <button type="button" onClick={() => void refreshRuns()}>{text.reconnectLocalApi}</button>
          </section>
        )}

        <section className="content-grid">
          <form className="run-panel" onSubmit={submitRun}>
            <div className="panel-title">
              <ClipboardList size={18} />
              {text.runConfiguration}
            </div>
            <label>
              {text.command}
              <select value={form.command} onChange={(event) => updateForm(setForm, "command", event.target.value as Command)}>
                {commands.map((command) => (
                  <option value={command} key={command}>{commandLabel(command, text)}</option>
                ))}
              </select>
            </label>
            <CommandBrief command={form.command} text={text} />
            {fields.inputPath && (
              <label>
                <LabelText label={text.inputCsv} badge={fields.rootPath ? text.optional : text.required} help={text.inputCsvHelp} />
                <div className="input-action-row">
                  <input value={form.input_path} onChange={(event) => updateForm(setForm, "input_path", event.target.value)} placeholder={text.inputCsvExample} />
                  <button className="secondary-action" type="button" onClick={chooseInputCsv}>
                    <Upload size={15} />
                    {text.chooseCsv}
                  </button>
                </div>
                <input ref={fileInputRef} className="file-input" type="file" accept=".csv,text/csv" onChange={handleInputCsvFileChange} />
                {uploadMessage && (
                  <div className="upload-status">
                    <span>{uploadMessage}</span>
                    {uploadProgress !== null && (
                      <div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div>
                    )}
                  </div>
                )}
                <FieldHelp>{text.inputCsvHelp}</FieldHelp>
              </label>
            )}
            {fields.rootPath && (
              <label>
                <LabelText label={text.rootDirectory} badge={fields.inputPath ? text.optional : text.required} help={text.rootDirectoryHelp} />
                <input value={form.root_path} onChange={(event) => updateForm(setForm, "root_path", event.target.value)} placeholder={text.rootDirectoryExample} />
                <FieldHelp>{text.rootDirectoryHelp}</FieldHelp>
              </label>
            )}
            {fields.outputPath && (
              <label>
                <LabelText label={text.outputFile} badge={text.optional} help={text.outputFileHelp} />
                <input value={form.output_path} onChange={(event) => updateForm(setForm, "output_path", event.target.value)} placeholder={text.outputFileExample} />
                <FieldHelp>{text.outputFileHelp}</FieldHelp>
              </label>
            )}
            {fields.outputDirectory && (
              <label>
                <LabelText label={text.outputDirectory} badge={text.optional} help={text.outputDirectoryHelp} />
                <input value={form.output_dir} onChange={(event) => updateForm(setForm, "output_dir", event.target.value)} placeholder={text.outputDirectoryExample} />
                <FieldHelp>{text.outputDirectoryHelp}</FieldHelp>
              </label>
            )}
            {form.command === "audit" && (fields.issueLogPath || fields.changeLogPath) && (
              <div className="two-col">
                {fields.issueLogPath && (
                  <label>
                    <LabelText label={text.issueLogFile} badge={form.command === "audit" ? text.optional : text.optional} help={text.issueLogFileHelp} />
                    <input value={form.issue_log_path} onChange={(event) => updateForm(setForm, "issue_log_path", event.target.value)} placeholder={text.issueLogFileExample} />
                    <FieldHelp>{text.issueLogFileHelp}</FieldHelp>
                  </label>
                )}
                {fields.changeLogPath && (
                  <label>
                    <LabelText label={text.changeLogFile} badge={form.command === "audit" ? text.optional : text.optional} help={text.changeLogFileHelp} />
                    <input value={form.change_log_path} onChange={(event) => updateForm(setForm, "change_log_path", event.target.value)} placeholder={text.changeLogFileExample} />
                    <FieldHelp>{text.changeLogFileHelp}</FieldHelp>
                  </label>
                )}
              </div>
            )}
            <details className="advanced-panel">
              <summary>{text.advancedSettings}</summary>
              <div className="advanced-grid">
                {fields.reportPath && (
                  <label>
                    <LabelText label={text.reportFile} badge={text.optional} help={text.reportFileHelp} />
                    <input value={form.report_path} onChange={(event) => updateForm(setForm, "report_path", event.target.value)} placeholder={text.reportFileExample} />
                    <FieldHelp>{text.reportFileHelp}</FieldHelp>
                  </label>
                )}
                {form.command !== "audit" && (fields.issueLogPath || fields.changeLogPath) && (
                  <div className="two-col">
                    {fields.issueLogPath && (
                      <label>
                        <LabelText label={text.issueLogFile} badge={text.optional} help={text.issueLogFileHelp} />
                        <input value={form.issue_log_path} onChange={(event) => updateForm(setForm, "issue_log_path", event.target.value)} placeholder={text.issueLogFileExample} />
                        <FieldHelp>{text.issueLogFileHelp}</FieldHelp>
                      </label>
                    )}
                    {fields.changeLogPath && (
                      <label>
                        <LabelText label={text.changeLogFile} badge={text.optional} help={text.changeLogFileHelp} />
                        <input value={form.change_log_path} onChange={(event) => updateForm(setForm, "change_log_path", event.target.value)} placeholder={text.changeLogFileExample} />
                        <FieldHelp>{text.changeLogFileHelp}</FieldHelp>
                      </label>
                    )}
                  </div>
                )}
                {fields.csvOptions && (
                  <div className="two-col">
                    <label>
                      <LabelText label={text.expectedColumns} badge={text.optional} help={text.expectedColumnsHelp} />
                      <input value={form.expected_columns} onChange={(event) => updateForm(setForm, "expected_columns", event.target.value)} placeholder={text.expectedColumnsExample} />
                      <FieldHelp>{text.expectedColumnsHelp}</FieldHelp>
                    </label>
                    <label>
                      <LabelText label={text.allQuoted} badge={text.optional} help={text.allQuotedHelp} />
                      <select value={form.all_quoted} onChange={(event) => updateForm(setForm, "all_quoted", event.target.value as "auto" | "true" | "false")}>
                        <option value="auto">auto</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                      <FieldHelp>{text.allQuotedHelp}</FieldHelp>
                    </label>
                  </div>
                )}
                {(fields.workers || fields.maxExamples) && (
                  <div className="two-col">
                    {fields.workers && (
                      <label>
                        <LabelText label={text.workers} badge={text.optional} help={text.workersHelp} />
                        <NumericTextInput value={form.workers} onChange={(value) => updateForm(setForm, "workers", value)} />
                        <FieldHelp>{text.workersHelp}</FieldHelp>
                      </label>
                    )}
                    {fields.maxExamples && (
                      <label>
                        <LabelText label={text.maxExamples} badge={text.optional} help={text.maxExamplesHelp} />
                        <NumericTextInput value={form.max_examples} onChange={(value) => updateForm(setForm, "max_examples", value)} />
                        <FieldHelp>{text.maxExamplesHelp}</FieldHelp>
                      </label>
                    )}
                  </div>
                )}
                {(fields.iterations || fields.progressEvery) && (
                  <div className="two-col">
                    {fields.iterations && (
                      <label>
                        <LabelText label={text.iterations} badge={text.optional} help={text.iterationsHelp} />
                        <NumericTextInput value={form.iterations} onChange={(value) => updateForm(setForm, "iterations", value)} />
                        <FieldHelp>{text.iterationsHelp}</FieldHelp>
                      </label>
                    )}
                    {fields.progressEvery && (
                      <label>
                        <LabelText label={text.progressEvery} badge={text.optional} help={text.progressEveryHelp} />
                        <NumericTextInput value={form.progress_every} onChange={(value) => updateForm(setForm, "progress_every", value)} />
                        <FieldHelp>{text.progressEveryHelp}</FieldHelp>
                      </label>
                    )}
                  </div>
                )}
                {fields.exclude && (
                  <>
                    <label>
                      <LabelText label={text.excludeFiles} badge={text.optional} help={text.excludeFilesHelp} />
                      <textarea value={form.exclude} onChange={(event) => updateForm(setForm, "exclude", event.target.value)} placeholder={text.excludeFilesExample} />
                      <FieldHelp>{text.excludeFilesHelp}</FieldHelp>
                    </label>
                    <label>
                      <LabelText label={text.excludeDirectories} badge={text.optional} help={text.excludeDirectoriesHelp} />
                      <textarea value={form.exclude_dir} onChange={(event) => updateForm(setForm, "exclude_dir", event.target.value)} placeholder={text.excludeDirectoriesExample} />
                      <FieldHelp>{text.excludeDirectoriesHelp}</FieldHelp>
                    </label>
                  </>
                )}
                {(fields.logIssues || fields.logChanges || fields.validateAfterRepair || fields.writeBom) && (
                  <div className="switch-row">
                    {fields.logIssues && <label><input type="checkbox" checked={form.log_all_issues} onChange={(event) => updateForm(setForm, "log_all_issues", event.target.checked)} /> {text.logIssues}</label>}
                    {fields.logChanges && <label><input type="checkbox" checked={form.log_all_changes} onChange={(event) => updateForm(setForm, "log_all_changes", event.target.checked)} /> {text.logChanges}</label>}
                    {fields.validateAfterRepair && <label><input type="checkbox" checked={form.validate_after_repair} onChange={(event) => updateForm(setForm, "validate_after_repair", event.target.checked)} /> {text.validate}</label>}
                    {fields.writeBom && <label><input type="checkbox" checked={form.write_bom} onChange={(event) => updateForm(setForm, "write_bom", event.target.checked)} /> {text.writeBom}</label>}
                  </div>
                )}
              </div>
            </details>
            <button className="primary-action" type="submit">
              <Play size={17} />
              {text.startRun}
            </button>
          </form>

          <section className="main-panel">
            <div className="panel-toolbar">
              <strong>{text.runs}</strong>
              <button className="secondary-action" type="button" onClick={refreshRuns}>
                <RefreshCw size={14} />
                {text.refresh}
              </button>
            </div>
            <RunTable runs={runs} selectedRunId={selectedRun?.job_id ?? ""} onSelect={selectRun} onOpenDetails={openRunDetails} text={text} />
          </section>
        </section>
        {detailsOpen && selectedRun && (
          <RunDetailsModal
            run={selectedRun}
            onLoadJsonl={(path) => {
              void loadJsonl(path);
            }}
            onLoadReport={(path) => {
              void loadReport(path);
            }}
            onLoadCsv={(path) => {
              void loadCsv(path);
            }}
            onClose={() => setDetailsOpen(false)}
            text={text}
          />
        )}
        {previewOpen && (
          <PreviewModal
            rows={viewerRows}
            columns={viewerColumns}
            groups={viewerGroups}
            selectedPath={viewerPathFilter}
            viewerKind={viewerKind}
            selectedIndex={selectedAuditIndex}
            onSelect={setSelectedAuditIndex}
            onSelectGroup={(path) => void loadJsonl(viewerPath, 0, path)}
            onRepairGroup={(path) => void repairIssueFile(path)}
            onRepairAllGroups={(groups) => void repairIssueFiles(groups)}
            onPreviewRepairGroup={(path) => void previewRepairIssueFile(path)}
            previewingRepairPath={previewingRepairPath}
            viewerPath={viewerPath}
            offset={viewerOffset}
            hasMore={viewerHasMore}
            onPrevious={() => loadViewerPage(Math.max(0, viewerOffset - 200))}
            onNext={() => loadViewerPage(viewerNextOffset)}
            onBack={() => setPreviewOpen(false)}
            onClose={() => setPreviewOpen(false)}
            text={text}
          />
        )}
      </section>
    </main>
  );
}

function RunTable({
  runs,
  selectedRunId,
  onSelect,
  onOpenDetails,
  text,
}: {
  runs: RunJob[];
  selectedRunId: string;
  onSelect: (id: string) => void;
  onOpenDetails: (run: RunJob) => void;
  text: Record<string, string>;
}) {
  return (
    <div className="table-wrap">
      <div className="table-hint">{text.doubleClickDetails}</div>
      <table>
        <thead>
          <tr>
            <th>{text.status}</th>
            <th>{text.command}</th>
            <th>{text.started}</th>
            <th>{text.elapsed}</th>
            <th>{text.issueFiles}</th>
            <th>{text.changes}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.job_id}
              className={run.job_id === selectedRunId ? "selected" : ""}
              onClick={() => onSelect(run.job_id)}
              onDoubleClick={() => onOpenDetails(run)}
            >
              <td className="status-cell">
                <StatusBadge status={run.status} />
                <ProgressMeter progress={run.progress} text={text} />
              </td>
              <td>{String(run.request?.command ?? "")}</td>
              <td>{formatRunTime(run.started_at)}</td>
              <td>{formatElapsed(run)}</td>
              <td>{run.progress?.issue_file_count ?? run.payload?.IssueFileCount ?? ""}</td>
              <td>{run.progress?.total_change_count ?? run.payload?.TotalChangeCount ?? run.payload?.TotalRepairChangeCount ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetails({
  run,
  onLoadJsonl,
  onLoadReport,
  onLoadCsv,
  text,
}: {
  run?: RunJob;
  onLoadJsonl: (path?: string) => void;
  onLoadReport: (path?: string) => void;
  onLoadCsv: (path?: string) => void;
  text: Record<string, string>;
}) {
  if (!run) {
    return <EmptyState label={text.noRun} />;
  }
  const payload = run.payload;
  const progressPath = payload?.ProgressPath ?? run.progress?.path;
  return (
    <div className="run-details">
      <section className="detail-section">
        <h3>{text.details}</h3>
        <dl className="detail-grid">
          <dt>{text.run}</dt>
          <dd>{run.job_id}</dd>
          <dt>{text.command}</dt>
          <dd>{String(run.request?.command ?? "")}</dd>
          <dt>{text.status}</dt>
          <dd>{run.status}</dd>
          <dt>{text.started}</dt>
          <dd>{formatRunTime(run.started_at)}</dd>
          <dt>{text.elapsed}</dt>
          <dd>{formatElapsed(run) || "-"}</dd>
          <dt>{text.inputCsv}</dt>
          <dd>{stringValue(run.request?.input_path) || "-"}</dd>
          <dt>{text.rootDirectory}</dt>
          <dd>{stringValue(run.request?.root_path) || "-"}</dd>
          <dt>{text.outputDir}</dt>
          <dd>{payload?.OutputDirectory ?? stringValue(run.request?.output_dir) ?? "-"}</dd>
        </dl>
      </section>
      <section className="detail-section">
        <h3>{text.viewRunArtifacts}</h3>
        <RunResultActions
          payload={payload ?? undefined}
          progressPath={progressPath}
          onLoadJsonl={onLoadJsonl}
          onLoadReport={onLoadReport}
          onLoadCsv={onLoadCsv}
          text={text}
        />
      </section>
      <section className="detail-section">
        <h3>{text.engineCommand}</h3>
        <pre className="detail-code">{run.command.join(" ")}</pre>
      </section>
      <section className="detail-section two-detail-columns">
        <div>
          <h3>{text.requestPayload}</h3>
          <pre className="detail-code">{JSON.stringify(run.request, null, 2)}</pre>
        </div>
        <div>
          <h3>{text.enginePayload}</h3>
          <pre className="detail-code">{JSON.stringify(run.payload ?? {}, null, 2)}</pre>
        </div>
      </section>
      {(run.stdout || run.stderr) && (
        <section className="detail-section two-detail-columns">
          <div>
            <h3>{text.stdout}</h3>
            <pre className="detail-code">{run.stdout || "-"}</pre>
          </div>
          <div>
            <h3>{text.stderr}</h3>
            <pre className="detail-code">{run.stderr || "-"}</pre>
          </div>
        </section>
      )}
    </div>
  );
}

function RunResultActions({
  payload,
  progressPath,
  onLoadJsonl,
  onLoadReport,
  onLoadCsv,
  text,
}: {
  payload?: RunPayload;
  progressPath?: string;
  onLoadJsonl: (path?: string) => void;
  onLoadReport: (path?: string) => void;
  onLoadCsv: (path?: string) => void;
  text: Record<string, string>;
}) {
  const issueBadge = payload?.IssueFileCount
    ? `${payload.IssueFileCount} / ${payload.TotalIssueCount ?? 0}`
    : undefined;
  const changeCount = payload?.TotalChangeCount ?? payload?.TotalRepairChangeCount;
  const changeBadge = typeof changeCount === "number" ? String(changeCount) : undefined;
  const actions = [
    {
      title: text.viewIssues,
      description: text.viewIssuesHint,
      badge: issueBadge,
      icon: <AlertTriangle size={18} />,
      disabled: !payload?.IssueLogPath,
      onClick: () => onLoadJsonl(payload?.IssueLogPath),
      tone: "danger",
    },
    {
      title: text.viewChanges,
      description: text.viewChangesHint,
      badge: changeBadge,
      icon: <GitCompare size={18} />,
      disabled: !payload?.ChangeLogPath,
      onClick: () => onLoadJsonl(payload?.ChangeLogPath),
      tone: "success",
    },
    {
      title: text.viewProgress,
      description: text.viewProgressHint,
      icon: <Gauge size={18} />,
      disabled: !progressPath,
      onClick: () => onLoadJsonl(progressPath),
    },
    {
      title: text.viewSummary,
      description: text.viewSummaryHint,
      icon: <FileSearch size={18} />,
      disabled: !payload?.SummaryJsonPath,
      onClick: () => onLoadReport(payload?.SummaryJsonPath),
    },
    {
      title: text.summaryCsv,
      description: text.summaryCsvHint,
      icon: <Database size={18} />,
      disabled: !payload?.SummaryCsvPath,
      onClick: () => onLoadCsv(payload?.SummaryCsvPath),
    },
  ];

  if (!actions.some((action) => !action.disabled)) {
    return <EmptyState label={text.noRunArtifacts} />;
  }

  return (
    <div className="result-action-grid">
      {actions.map((action) => (
        <button
          type="button"
          key={action.title}
          className={`result-action ${action.tone ?? ""}`}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          <span className="result-action-icon">{action.icon}</span>
          <span className="result-action-copy">
            <strong>{action.title}</strong>
            <span>{action.description}</span>
          </span>
          {action.badge && <span className="result-action-badge">{action.badge}</span>}
        </button>
      ))}
    </div>
  );
}

function ArtifactPanel({
  run,
  onLoadJsonl,
  onLoadReport,
  onLoadCsv,
  text,
}: {
  run?: RunJob;
  onLoadJsonl: (path?: string) => void;
  onLoadReport: (path?: string) => void;
  onLoadCsv: (path?: string) => void;
  text: Record<string, string>;
}) {
  const payload = run?.payload;
  const progressPath = payload?.ProgressPath ?? run?.progress?.path;
  if (!run) {
    return <EmptyState label={text.noRun} />;
  }
  return (
    <div className="artifact-grid">
      <Artifact title={text.outputDir} value={payload?.OutputDirectory} icon={<Database size={18} />} text={text} />
      <Artifact title={text.summaryJson} value={payload?.SummaryJsonPath} icon={<FileSearch size={18} />} onOpen={() => onLoadReport(payload?.SummaryJsonPath)} text={text} />
      <Artifact title={text.summaryCsv} value={payload?.SummaryCsvPath} icon={<FileSearch size={18} />} onOpen={() => onLoadCsv(payload?.SummaryCsvPath)} text={text} />
      <Artifact title={text.progressJsonl} value={progressPath} icon={<Gauge size={18} />} onOpen={() => onLoadJsonl(progressPath)} text={text} />
      <Artifact title={text.issuesJsonl} value={payload?.IssueLogPath} icon={<AlertTriangle size={18} />} onOpen={() => onLoadJsonl(payload?.IssueLogPath)} text={text} />
      <Artifact title={text.changesJsonl} value={payload?.ChangeLogPath} icon={<GitCompare size={18} />} onOpen={() => onLoadJsonl(payload?.ChangeLogPath)} text={text} />
    </div>
  );
}

function RunDetailsModal({
  run,
  onLoadJsonl,
  onLoadReport,
  onLoadCsv,
  onClose,
  text,
}: {
  run: RunJob;
  onLoadJsonl: (path?: string) => void;
  onLoadReport: (path?: string) => void;
  onLoadCsv: (path?: string) => void;
  onClose: () => void;
  text: Record<string, string>;
}) {
  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={text.details}>
      <div className="preview-modal run-detail-modal">
        <header className="preview-header">
          <div>
            <strong>{text.details}</strong>
            <code>{run.job_id}</code>
          </div>
          <button type="button" onClick={onClose}>{text.closeDetails}</button>
        </header>
        <RunDetails
          run={run}
          onLoadJsonl={onLoadJsonl}
          onLoadReport={onLoadReport}
          onLoadCsv={onLoadCsv}
          text={text}
        />
      </div>
    </div>
  );
}

function Artifact({ title, value, icon, onOpen, text }: { title: string; value?: string; icon: React.ReactNode; onOpen?: () => void; text: Record<string, string> }) {
  return (
    <div className="artifact">
      <div className="artifact-title">{icon}{title}</div>
      <code>{value || text.notAvailable}</code>
      {onOpen && value && <button onClick={onOpen}>{text.openPreview}</button>}
    </div>
  );
}

function PreviewModal({
  rows,
  columns,
  groups,
  selectedPath,
  viewerKind,
  selectedIndex,
  onSelect,
  onSelectGroup,
  onRepairGroup,
  onRepairAllGroups,
  onPreviewRepairGroup,
  previewingRepairPath,
  viewerPath,
  offset,
  hasMore,
  onPrevious,
  onNext,
  onBack,
  onClose,
  text,
}: {
  rows: unknown[];
  columns: string[];
  groups: JsonlGroup[];
  selectedPath: string;
  viewerKind: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onSelectGroup: (path: string) => void;
  onRepairGroup: (path: string) => void;
  onRepairAllGroups: (groups: JsonlGroup[]) => void;
  onPreviewRepairGroup: (path: string) => void;
  previewingRepairPath: string;
  viewerPath: string;
  offset: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onBack: () => void;
  onClose: () => void;
  text: Record<string, string>;
}) {
  return (
    <div className="preview-overlay" role="dialog" aria-modal="true" aria-label={text.preview}>
      <div className="preview-modal">
        <header className="preview-header">
          <div>
            <strong>{text.preview}</strong>
            <code>{viewerPath || text.notAvailable}</code>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onBack}>{text.back}</button>
            <button type="button" onClick={onClose}>{text.closePreview}</button>
          </div>
        </header>
        <AuditViewer
          rows={rows}
          columns={columns}
          groups={groups}
          selectedPath={selectedPath}
          viewerKind={viewerKind}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onSelectGroup={onSelectGroup}
          onRepairGroup={onRepairGroup}
          onRepairAllGroups={onRepairAllGroups}
          onPreviewRepairGroup={onPreviewRepairGroup}
          previewingRepairPath={previewingRepairPath}
          viewerPath={viewerPath}
          offset={offset}
          hasMore={hasMore}
          onPrevious={onPrevious}
          onNext={onNext}
          text={text}
        />
      </div>
    </div>
  );
}

function AuditViewer({
  rows,
  columns,
  groups,
  selectedPath,
  viewerKind,
  selectedIndex,
  onSelect,
  onSelectGroup,
  onRepairGroup,
  onRepairAllGroups,
  onPreviewRepairGroup,
  previewingRepairPath,
  viewerPath,
  offset,
  hasMore,
  onPrevious,
  onNext,
  text,
}: {
  rows: unknown[];
  columns: string[];
  groups: JsonlGroup[];
  selectedPath: string;
  viewerKind: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onSelectGroup: (path: string) => void;
  onRepairGroup: (path: string) => void;
  onRepairAllGroups: (groups: JsonlGroup[]) => void;
  onPreviewRepairGroup: (path: string) => void;
  previewingRepairPath: string;
  viewerPath: string;
  offset: number;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  text: Record<string, string>;
}) {
  if (rows.length === 0 && !(viewerKind === "jsonl" && groups.length > 0)) {
    return <EmptyState label={text.openArtifact} />;
  }
  return (
    <div className="viewer-panel">
      {!(viewerKind === "jsonl" && groups.length > 0 && !selectedPath) && (
        <div className="viewer-toolbar">
          <code>{selectedPath || viewerPath || text.notAvailable}</code>
          <div className="action-row">
            <button type="button" disabled={offset <= 0} onClick={onPrevious}>{text.previousPage}</button>
            <button type="button" disabled={!hasMore} onClick={onNext}>{text.nextPage}</button>
          </div>
        </div>
      )}
      {viewerKind === "csv" ? (
        <CsvPreview rows={rows} columns={columns} selectedIndex={selectedIndex} onSelect={onSelect} />
      ) : viewerKind === "jsonl" && groups.length > 0 && !selectedPath ? (
        <JsonlFileGroups
          groups={groups}
          onSelectGroup={onSelectGroup}
          onRepairGroup={onRepairGroup}
          onRepairAllGroups={onRepairAllGroups}
          onPreviewRepairGroup={onPreviewRepairGroup}
          previewingRepairPath={previewingRepairPath}
          text={text}
        />
      ) : viewerKind === "jsonl" && groups.length > 0 && selectedPath ? (
        <JsonlIssueRows
          rows={rows}
          selectedPath={selectedPath}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onPreviewRepairGroup={onPreviewRepairGroup}
          previewingRepairPath={previewingRepairPath}
          text={text}
        />
      ) : (
        <div className="audit-list">
          {rows.map((row, index) => (
            <button className={index === selectedIndex ? "audit-row selected" : "audit-row"} key={index} onClick={() => onSelect(index)}>
              <pre>{JSON.stringify(row, null, 2)}</pre>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonlFileGroups({
  groups,
  onSelectGroup,
  onRepairGroup,
  onRepairAllGroups,
  onPreviewRepairGroup,
  previewingRepairPath,
  text,
}: {
  groups: JsonlGroup[];
  onSelectGroup: (path: string) => void;
  onRepairGroup: (path: string) => void;
  onRepairAllGroups: (groups: JsonlGroup[]) => void;
  onPreviewRepairGroup: (path: string) => void;
  previewingRepairPath: string;
  text: Record<string, string>;
}) {
  return (
    <div className="file-group-panel">
      <div className="file-group-header">
        <div>
          <h3>{text.fileGroups}</h3>
          <p>{text.fileGroupHint}</p>
        </div>
        <button className="secondary-action" type="button" onClick={() => onRepairAllGroups(groups)}>
          <Wrench size={14} />
          {text.repairAllIssueFiles}
        </button>
      </div>
      <div className="file-group-list">
        {groups.map((group) => (
          <div className="file-group-row" key={group.path}>
            <button className="file-group-open" type="button" onClick={() => onSelectGroup(group.path)}>
              <span className="file-group-main">
                <strong>{group.path}</strong>
                <span>{text.issueTypeSummary}: {issueTypeSummary(group.issue_types)}</span>
              </span>
              <span className="file-group-count">{group.count}</span>
            </button>
            <button className="file-group-repair" type="button" onClick={() => onRepairGroup(group.path)}>
              <Wrench size={14} />
              {text.repairThisFile}
            </button>
            <button
              className="file-group-repair preview"
              type="button"
              disabled={Boolean(previewingRepairPath)}
              onClick={() => onPreviewRepairGroup(group.path)}
            >
              <FileSearch size={14} />
              {previewingRepairPath === group.path ? text.previewRepairBusy : text.previewRepairChanges}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function JsonlIssueRows({
  rows,
  selectedPath,
  selectedIndex,
  onSelect,
  onPreviewRepairGroup,
  previewingRepairPath,
  text,
}: {
  rows: unknown[];
  selectedPath: string;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPreviewRepairGroup: (path: string) => void;
  previewingRepairPath: string;
  text: Record<string, string>;
}) {
  const isRepairChangeView = rows.some((row) => {
    const record = isRecord(row) ? row : {};
    return Boolean(record.RepairedContext ?? record.repaired_context ?? record.RepairedText ?? record.repaired_text);
  });
  return (
    <div className="audit-list">
      <div className="issue-row-header">
        <div>
          <div className="issue-row-title">{isRepairChangeView ? text.repairPreviewChanges : text.currentFileIssues}</div>
          {!isRepairChangeView && <p>{text.previewRepairChangesHint}</p>}
        </div>
        {!isRepairChangeView && (
          <button
            className="secondary-action"
            type="button"
            disabled={!selectedPath || Boolean(previewingRepairPath)}
            onClick={() => onPreviewRepairGroup(selectedPath)}
          >
            <FileSearch size={14} />
            {previewingRepairPath === selectedPath ? text.previewRepairBusy : text.previewRepairChanges}
          </button>
        )}
      </div>
      {rows.map((row, index) => (
        <button className={index === selectedIndex ? "issue-card selected" : "issue-card"} key={index} onClick={() => onSelect(index)}>
          <IssueCard row={row} text={text} />
        </button>
      ))}
    </div>
  );
}

function projectRepairPreviewRows(rows: unknown[], limit: number) {
  return rows
    .slice(0, Math.max(1, limit))
    .map((row) => projectRepairPreviewRow(row))
    .filter((row): row is Record<string, unknown> => Boolean(row));
}

function projectRepairPreviewRow(row: unknown) {
  if (!isRecord(row)) {
    return null;
  }
  const issueType = String(row.IssueType ?? row.issue_type ?? "issue");
  const originalContext = stringValue(row.OriginalContext ?? row.Snippet ?? row.original_context ?? "");
  if (!originalContext) {
    return { ...row };
  }
  const projection = projectRepairContext(issueType, originalContext);
  return {
    ...row,
    OriginalContext: originalContext,
    RepairedContext: projection.repairedContext,
    OriginalText: projection.originalText,
    RepairedText: projection.repairedText,
    Detail: projection.detail || row.Detail || row.detail || "projected repair preview",
  };
}

function projectRepairContext(issueType: string, originalContext: string) {
  const loweredIssueType = issueType.toLowerCase();
  if (loweredIssueType.includes("quote")) {
    const repairedContext = originalContext.replaceAll('"', '""');
    return {
      originalText: '"',
      repairedText: '""',
      repairedContext,
      detail: "quote characters are projected to be escaped as doubled quotes",
    };
  }
  return {
    originalText: "",
    repairedText: "",
    repairedContext: originalContext,
    detail: "no deterministic single-character preview is available for this issue type",
  };
}

function IssueCard({ row, text }: { row: unknown; text: Record<string, string> }) {
  const record = isRecord(row) ? row : {};
  const originalContext = stringValue(record.OriginalContext ?? record.Snippet ?? record.original_context ?? "");
  const repairedContext = stringValue(record.RepairedContext ?? record.repaired_context ?? "");
  const originalText = stringValue(record.OriginalText ?? record.original_text ?? "");
  const repairedText = stringValue(record.RepairedText ?? record.repaired_text ?? "");
  const issueType = String(record.IssueType ?? record.issue_type ?? "issue");
  const originalHighlight = originalText || inferIssueHighlight(issueType, originalContext);
  const repairedHighlight = repairedText || inferIssueHighlight(issueType, repairedContext);
  const hasRepairContext = Boolean(repairedContext);
  return (
    <div className="issue-card-body">
      <div className="issue-card-top">
        <strong>{issueType}</strong>
        <span>{text.record}: {String(record.RecordNumber ?? "-")}</span>
        <span>{text.column}: {String(record.ColumnNumber ?? "-")}</span>
        <span>{text.byteOffset}: {String(record.ByteOffset ?? "-")}</span>
      </div>
      {hasRepairContext && (originalText || repairedText) && (
        <DiffTokenSummary before={originalText} after={repairedText} text={text} />
      )}
      {(originalContext || repairedContext) ? (
        <div className={hasRepairContext ? "context-diff-grid" : "context-diff-grid single"}>
          <ContextBlock title={text.originalContext} value={originalContext} highlight={originalHighlight} tone="original" />
          {hasRepairContext && (
            <ContextBlock title={text.repairedContext} value={repairedContext} highlight={repairedHighlight} tone="repaired" />
          )}
        </div>
      ) : (
        <pre className="compact-json">{JSON.stringify(row, null, 2)}</pre>
      )}
    </div>
  );
}

function DiffTokenSummary({ before, after, text }: { before: string; after: string; text: Record<string, string> }) {
  return (
    <div className="diff-token-summary">
      <span>{text.projectedPreview}</span>
      <code className="before">{text.beforeToken}: {displayToken(before)}</code>
      <span className="diff-arrow">-&gt;</span>
      <code className="after">{text.afterToken}: {displayToken(after)}</code>
    </div>
  );
}

function displayToken(value: string) {
  if (!value) {
    return "-";
  }
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
}

function ContextBlock({ title, value, highlight, tone }: { title: string; value: string; highlight: string; tone: "original" | "repaired" }) {
  return (
    <section className={`context-block ${tone}`}>
      <h4>{title}</h4>
      <pre>{highlightText(value, highlight)}</pre>
    </section>
  );
}

function CsvPreview({ rows, columns, selectedIndex, onSelect }: { rows: unknown[]; columns: string[]; selectedIndex: number; onSelect: (index: number) => void }) {
  return (
    <div className="csv-preview">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const record = isRecord(row) ? row : {};
            return (
              <tr key={index} className={index === selectedIndex ? "selected" : ""} onClick={() => onSelect(index)}>
                {columns.map((column) => (
                  <td key={column}>{String(record[column] ?? "")}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LabelText({ label, badge, help }: { label: string; badge: string; help?: React.ReactNode }) {
  return (
    <span className="label-line">
      <span className="label-title">
        <span>{label}</span>
        {help && (
          <span className="help-anchor" tabIndex={0} aria-label={String(help)}>
            !
            <span className="help-tooltip">{help}</span>
          </span>
        )}
      </span>
      <span className={badge === "必填" || badge === "required" ? "field-badge required" : "field-badge"}>{badge}</span>
    </span>
  );
}

function FieldHelp({ children }: { children: React.ReactNode }) {
  void children;
  return null;
}

function NumericTextInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onChange={(event) => {
        const nextValue = event.target.value.replace(/\D/g, "");
        onChange(nextValue);
      }}
    />
  );
}

function CommandBrief({ command, text }: { command: Command; text: Record<string, string> }) {
  const brief = commandBrief(command, text);
  return (
    <section className="command-brief">
      <div className="command-brief-title">
        <Info size={15} />
        <strong>{commandLabel(command, text)}</strong>
      </div>
      <p>{brief.description}</p>
      <dl>
        <dt>{text.reads}</dt>
        <dd>{brief.reads}</dd>
        <dt>{text.writes}</dt>
        <dd>{brief.writes}</dd>
        <dt>{text.dataImpact}</dt>
        <dd>{brief.impact}</dd>
      </dl>
    </section>
  );
}

function InspectorPanel({
  run,
  row,
  onLoadJsonl,
  onLoadReport,
  onRepairSelectedFile,
  onRepairRunScope,
  text,
}: {
  run?: RunJob;
  row?: unknown;
  onLoadJsonl: (path?: string) => void;
  onLoadReport: (path?: string) => void;
  onRepairSelectedFile: (row: unknown) => void;
  onRepairRunScope: (run?: RunJob) => void;
  text: Record<string, string>;
}) {
  const record = isRecord(row) ? row : undefined;
  const payload = run?.payload;
  const progressPath = payload?.ProgressPath ?? run?.progress?.path;
  const selectedFilePath = getRecordPath(record);
  const canRepairScope = Boolean(run && run.request?.command === "scan" && (stringValue(run.request?.root_path) || stringValue(run.request?.input_path)));
  return (
    <aside className="inspector-panel">
      <div className="inspector-title">
        <GitCompare size={18} />
        {text.issueInspector}
      </div>
      <section className="inspector-actions">
        <h3>{text.viewRunArtifacts}</h3>
        <div className="action-row">
          <button type="button" disabled={!payload?.IssueLogPath} onClick={() => onLoadJsonl(payload?.IssueLogPath)}>{text.viewIssues}</button>
          <button type="button" disabled={!payload?.ChangeLogPath} onClick={() => onLoadJsonl(payload?.ChangeLogPath)}>{text.viewChanges}</button>
          <button type="button" disabled={!progressPath} onClick={() => onLoadJsonl(progressPath)}>{text.viewProgress}</button>
          <button type="button" disabled={!payload?.SummaryJsonPath} onClick={() => onLoadReport(payload?.SummaryJsonPath)}>{text.viewSummary}</button>
        </div>
      </section>
      <section className="inspector-actions repair">
        <h3>{text.repairActions}</h3>
        <div className="action-row">
          <button type="button" disabled={!selectedFilePath} onClick={() => onRepairSelectedFile(row)}>
            <Wrench size={14} />
            {text.repairSelectedFile}
          </button>
          <button type="button" disabled={!canRepairScope} onClick={() => onRepairRunScope(run)}>
            <Wrench size={14} />
            {text.repairScanScope}
          </button>
        </div>
      </section>
      <dl className="inspector-facts">
        <dt>{text.run}</dt>
        <dd>{run?.job_id?.slice(0, 10) ?? "-"}</dd>
        <dt>{text.status}</dt>
        <dd>{run?.status ?? "-"}</dd>
        {run?.progress && (
          <>
            <dt>{text.progress}</dt>
            <dd>{formatProgressPercent(run.progress)}</dd>
            <dt>{text.processed}</dt>
            <dd>{formatProgressRatio(run.progress)}</dd>
            <dt>{text.issueFiles}</dt>
            <dd>{String(run.progress.issue_file_count ?? "-")}</dd>
            <dt>{text.changes}</dt>
            <dd>{String(run.progress.total_change_count ?? "-")}</dd>
          </>
        )}
        <dt>{text.issue}</dt>
        <dd>{String(record?.IssueType ?? "-")}</dd>
        <dt>{text.record}</dt>
        <dd>{String(record?.RecordNumber ?? "-")}</dd>
        <dt>{text.column}</dt>
        <dd>{String(record?.ColumnNumber ?? "-")}</dd>
        <dt>{text.byteOffset}</dt>
        <dd>{String(record?.ByteOffset ?? "-")}</dd>
      </dl>
      <section className="diff-box original">
        <h3>{text.originalContext}</h3>
        <pre>{String(record?.OriginalContext ?? record?.Snippet ?? text.openJsonlFirst)}</pre>
      </section>
      <section className="diff-box repaired">
        <h3>{text.repairedContext}</h3>
        <pre>{String(record?.RepairedContext ?? text.repairedContextMissing)}</pre>
      </section>
      <section className="byte-box">
        <span>{text.originalBytes}</span>
        <code>{String(record?.OriginalBytesHex ?? "-")}</code>
        <span>{text.repairedBytes}</span>
        <code>{String(record?.RepairedBytesHex ?? "-")}</code>
      </section>
    </aside>
  );
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === "ok";
  const running = status === "running" || status === "queued";
  return (
    <span className={`status-badge ${ok ? "ok" : running ? "running" : "issue"}`}>
      {ok ? <CheckCircle2 size={14} /> : running ? <Activity size={14} /> : <AlertTriangle size={14} />}
      {status}
    </span>
  );
}

function ProgressMeter({ progress, text }: { progress?: RunProgress | null; text: Record<string, string> }) {
  if (!progress) {
    return null;
  }
  const total = progress.csv_count ?? 0;
  const processed = progress.scanned_count ?? progress.repaired_count ?? 0;
  const percent = progress.percent ?? (total > 0 ? Math.round((processed / total) * 1000) / 10 : undefined);
  const hasRatio = total > 0;
  return (
    <div className="progress-meter">
      <div className="progress-line">
        <span>{hasRatio ? `${text.processed} ${processed}/${total}` : text.waitingProgress}</span>
        <strong>{typeof percent === "number" ? `${percent}%` : progress.status ?? ""}</strong>
      </div>
      <div className="progress-track" aria-label={text.progress}>
        <span style={{ width: `${typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0}%` }} />
      </div>
    </div>
  );
}

function EmptyState({ label = "No run selected." }: { label?: string }) {
  return <div className="empty-state">{label}</div>;
}

function buildMetrics(run: RunJob | undefined, text: Record<string, string>) {
  return [
    { label: text.runStatus, value: run?.status ?? text.idle },
    { label: text.csvFiles, value: String(run?.progress?.csv_count ?? run?.payload?.CsvCount ?? 0) },
    { label: text.issueFiles, value: String(run?.progress?.issue_file_count ?? run?.payload?.IssueFileCount ?? 0) },
    { label: text.changes, value: String(run?.progress?.total_change_count ?? run?.payload?.TotalChangeCount ?? run?.payload?.TotalRepairChangeCount ?? 0) },
    { label: text.validation, value: run?.payload?.Validation?.Status ?? run?.payload?.Status ?? "-" },
  ];
}

function commandLabel(command: Command, text: Record<string, string>) {
  switch (command) {
    case "scan":
      return text.scanLabel;
    case "repair":
      return text.repairLabel;
    case "validate":
      return text.validateLabel;
    case "audit":
      return text.auditLabel;
    case "benchmark":
      return text.benchmarkLabel;
  }
}

function commandBrief(command: Command, text: Record<string, string>) {
  switch (command) {
    case "scan":
      return { description: text.scanDescription, reads: text.scanReads, writes: text.scanWrites, impact: text.scanImpact };
    case "repair":
      return { description: text.repairDescription, reads: text.repairReads, writes: text.repairWrites, impact: text.repairImpact };
    case "validate":
      return { description: text.validateDescription, reads: text.validateReads, writes: text.validateWrites, impact: text.validateImpact };
    case "audit":
      return { description: text.auditDescription, reads: text.auditReads, writes: text.auditWrites, impact: text.auditImpact };
    case "benchmark":
      return { description: text.benchmarkDescription, reads: text.benchmarkReads, writes: text.benchmarkWrites, impact: text.benchmarkImpact };
  }
}

function commandHint(command: Command, text: Record<string, string>) {
  switch (command) {
    case "scan":
      return text.scanHint;
    case "repair":
      return text.repairHint;
    case "validate":
      return text.validateHint;
    case "audit":
      return text.auditHint;
    case "benchmark":
      return text.benchmarkHint;
  }
}

function commandFields(command: Command) {
  return {
    inputPath: command === "scan" || command === "repair" || command === "validate" || command === "benchmark",
    rootPath: command === "scan" || command === "repair",
    outputPath: command === "repair",
    outputDirectory: command === "scan" || command === "repair" || command === "audit" || command === "benchmark",
    reportPath: command === "repair",
    issueLogPath: command === "scan" || command === "audit",
    changeLogPath: command === "repair" || command === "audit",
    csvOptions: command === "scan" || command === "repair" || command === "validate" || command === "benchmark",
    workers: command === "scan" || command === "repair",
    maxExamples: command === "scan" || command === "repair" || command === "validate" || command === "benchmark",
    iterations: command === "benchmark",
    progressEvery: command === "scan" || command === "repair",
    exclude: command === "scan" || command === "repair",
    logIssues: command === "scan",
    logChanges: command === "repair",
    validateAfterRepair: command === "repair",
    writeBom: command === "repair",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRecordPath(value: unknown) {
  if (!isRecord(value)) {
    return "";
  }
  return stringValue(value.Path ?? value.path ?? value.InputPath ?? value.input_path);
}

function rowsForPath(rows: unknown[], path: string) {
  const sourceRows = rows.filter(rowHasPreviewSource);
  const matchingRows = sourceRows.filter((row) => pathsEqual(getRecordPath(row), path));
  return matchingRows.length > 0 ? matchingRows : sourceRows;
}

function rowHasPreviewSource(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }
  return Boolean(value.OriginalContext ?? value.Snippet ?? value.original_context ?? value.RepairedContext ?? value.repaired_context);
}

function pathsEqual(left: string, right: string) {
  if (!left || !right) {
    return false;
  }
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function normalizePathForCompare(value: string) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function listValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveIntegerValue(value: unknown, fallback: number) {
  const textValue = String(value ?? "").trim();
  if (!textValue) {
    return fallback;
  }
  const parsedValue = Number(textValue);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function nullableNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function expectedColumnsValue(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "auto") {
    return null;
  }
  const number = Number(trimmed);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function allQuotedValue(value: unknown): "auto" | "true" | "false" {
  return value === "true" || value === "false" ? value : "auto";
}

function splitLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function issueTypeSummary(issueTypes?: Record<string, number>) {
  if (!issueTypes) {
    return "-";
  }
  const values = Object.entries(issueTypes)
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([issueType, count]) => `${issueType} ${count}`);
  return values.length ? values.join(", ") : "-";
}

function inferIssueHighlight(issueType: string, context: string) {
  const loweredIssueType = issueType.toLowerCase();
  if (!context) {
    return "";
  }
  if (loweredIssueType.includes("quote")) {
    if (context.includes('\\"')) {
      return '\\"';
    }
    if (context.includes('"')) {
      return '"';
    }
    if (context.includes("“")) {
      return "“";
    }
    if (context.includes("”")) {
      return "”";
    }
  }
  return "";
}

function highlightText(value: string, highlight: string) {
  const candidates = getHighlightCandidates(highlight);
  if (candidates.length === 0) {
    return value;
  }
  for (const candidate of candidates) {
    if (!value.includes(candidate)) {
      continue;
    }
    const parts = value.split(candidate);
    return (
      <>
        {parts.map((part, index) => (
          <React.Fragment key={`${candidate}-${index}`}>
            {part}
            {index < parts.length - 1 && <mark>{candidate}</mark>}
          </React.Fragment>
        ))}
      </>
    );
  }
  return value;
}

function getHighlightCandidates(highlight: string) {
  if (!highlight) {
    return [];
  }
  const candidates = [
    highlight,
    highlight.replaceAll('"', '\\"'),
    highlight.replaceAll("\\", "\\\\"),
    highlight === '"' ? '\\"' : "",
    highlight === '"' ? "“" : "",
    highlight === '"' ? "”" : "",
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    return true;
  });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatRunTime(value: string) {
  return value.length >= 19 ? `${value.slice(5, 10)} ${value.slice(11, 19)}` : value;
}

function formatElapsed(run: RunJob) {
  const elapsed = run.progress?.elapsed_seconds ?? run.elapsed_seconds;
  return typeof elapsed === "number" ? elapsed : "";
}

function formatProgressPercent(progress: RunProgress) {
  if (typeof progress.percent === "number") {
    return `${progress.percent}%`;
  }
  return progress.status ?? "-";
}

function formatProgressRatio(progress: RunProgress) {
  const total = progress.csv_count;
  const processed = progress.scanned_count ?? progress.repaired_count;
  if (typeof processed === "number" && typeof total === "number") {
    return `${processed}/${total}`;
  }
  return "-";
}

function loadInitialForm() {
  try {
    const saved = window.localStorage.getItem("csvRepairWorkbenchForm");
    if (!saved) {
      return defaultForm;
    }
    const loaded = { ...defaultForm, ...JSON.parse(saved) } as FormState;
    return {
      ...loaded,
      workers: String(loaded.workers ?? defaultForm.workers),
      max_examples: String(loaded.max_examples ?? defaultForm.max_examples),
      progress_every: String(loaded.progress_every ?? defaultForm.progress_every),
      iterations: String(loaded.iterations ?? defaultForm.iterations),
    };
  } catch {
    return defaultForm;
  }
}

function updateForm<K extends keyof FormState>(setForm: React.Dispatch<React.SetStateAction<FormState>>, key: K, value: FormState[K]) {
  setForm((current) => ({ ...current, [key]: value }));
}

createRoot(document.getElementById("root")!).render(<App />);
