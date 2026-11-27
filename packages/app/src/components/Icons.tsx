/* eslint-disable react-refresh/only-export-components -- Icon re-exports barrel file */
// Icon components - powered by lucide-react
// Re-exports with project defaults (size=16, aria-hidden)
import type { SVGProps, ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  SquarePen,
  Hand,
  Keyboard,
  Check,
  Send,
  Plus,
  GraduationCap,
  Settings,
  Sun,
  Moon,
  Monitor,
  PanelLeft,
  PanelRight,
  PanelBottom,
  Image,
  Copy,
  Code2,
  Brain,
  ExternalLink,
  X,
  Sparkles,
  Undo2,
  Redo2,
  Terminal,
  File,
  Folder,
  FolderOpen,
  FolderMinus,
  Search,
  Pencil,
  Trash2,
  CornerDownLeft,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  Share,
  Link,
  Globe,
  MessageSquare,
  ArrowUp,
  ArrowDown,
  Clock,
  Circle,
  CircleAlert,
  RefreshCcw,
  Cpu,
  DollarSign,
  Lightbulb,
  Users,
  GitCommitHorizontal,
  GitBranch,
  Split,
  Plug,
  KeyRound,
  Wifi,
  WifiOff,
  Bell,
  Download,
  Pin,
  Square,
  LoaderCircle,
  CircleHelp,
  Puzzle,
  Slash,
  FileDiff,
  Waypoints,
  GitCompare,
  ListTodo,
  ListFilter,
  Layers,
  Minus,
  Paperclip,
  FastForward,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Target,
  Upload,
  Shield,
  Columns2,
  Rows2,
  GripVertical,
  EllipsisVertical,
  AppWindow,
  ZoomIn,
  ZoomOut,
  TriangleAlert,
} from 'lucide-react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number | string
}

// ============================================
// Wrapper: apply project defaults (size=16, aria-hidden)
// ============================================

function wrap(Icon: ComponentType<LucideProps>) {
  const Wrapped = ({ size = 16, ...props }: IconProps) => (
    <Icon size={size} aria-hidden="true" {...(props as LucideProps)} />
  )
  return Wrapped
}

// ============================================
// Lucide-backed icons
// ============================================

export const ChevronDownIcon = wrap(ChevronDown)
export const ChevronUpIcon = wrap(ChevronUp)
export const ChevronLeftIcon = wrap(ChevronLeft)
export const ChevronRightIcon = wrap(ChevronRight)
export const NewChatIcon = wrap(SquarePen)
export const HandIcon = wrap(Hand)
export const KeyboardIcon = wrap(Keyboard)
export const CheckIcon = wrap(Check)
export const SendIcon = wrap(Send)
export const PlusIcon = wrap(Plus)
export const TeachIcon = wrap(GraduationCap)
export const SettingsIcon = wrap(Settings)
export const SunIcon = wrap(Sun)
export const MoonIcon = wrap(Moon)
export const SystemIcon = wrap(Monitor)
export const SidebarIcon = wrap(PanelLeft)
export const PanelRightIcon = wrap(PanelRight)
export const PanelBottomIcon = wrap(PanelBottom)
export const ImageIcon = wrap(Image)
export const CopyIcon = wrap(Copy)
export const CodeIcon = wrap(Code2)
export const AgentIcon = wrap(Brain)
export const ExpandIcon = wrap(ExternalLink)
export const CloseIcon = wrap(X)
export const ThinkingIcon = wrap(Sparkles)
export const UndoIcon = wrap(Undo2)
export const RedoIcon = wrap(Redo2)
export const TerminalIcon = wrap(Terminal)
export const FileIcon = wrap(File)
export const FolderIcon = wrap(Folder)
export const FolderOpenIcon = wrap(FolderOpen)
export const FolderMinusIcon = wrap(FolderMinus)
export const SearchIcon = wrap(Search)
export const PencilIcon = wrap(Pencil)
export const TrashIcon = wrap(Trash2)
export const ReturnIcon = wrap(CornerDownLeft)
export const EyeIcon = wrap(Eye)
export const EyeOffIcon = wrap(EyeOff)
export const MaximizeIcon = wrap(Maximize)
export const MinimizeIcon = wrap(Minimize)
export const ShareIcon = wrap(Share)
export const LinkIcon = wrap(Link)
export const ExternalLinkIcon = wrap(ExternalLink)
export const GlobeIcon = wrap(Globe)
export const MessageSquareIcon = wrap(MessageSquare)
export const ArrowUpIcon = wrap(ArrowUp)
export const ArrowDownIcon = wrap(ArrowDown)
export const ClockIcon = wrap(Clock)
export const CircleIcon = wrap(Circle)
export const AlertCircleIcon = wrap(CircleAlert)
export const AlertTriangleIcon = wrap(TriangleAlert)
export const RetryIcon = wrap(RefreshCcw)
export const ZoomInIcon = wrap(ZoomIn)
export const ZoomOutIcon = wrap(ZoomOut)
export const CpuIcon = wrap(Cpu)
export const DollarSignIcon = wrap(DollarSign)
export const LightbulbIcon = wrap(Lightbulb)
export const UsersIcon = wrap(Users)
export const GitCommitIcon = wrap(GitCommitHorizontal)
export const GitBranchIcon = wrap(GitBranch)
export const SplitIcon = wrap(Split)
export const PlugIcon = wrap(Plug)
export const KeyIcon = wrap(KeyRound)
export const WifiIcon = wrap(Wifi)
export const WifiOffIcon = wrap(WifiOff)
export const BellIcon = wrap(Bell)
export const DownloadIcon = wrap(Download)
export const PinIcon = wrap(Pin)

// Aliases
export const ComposeIcon = wrap(SquarePen)
export const CogIcon = wrap(Settings)

// ============================================
// Icons with custom defaults (lucide-backed)
// ============================================

export const StopIcon = ({ size = 16, ...props }: IconProps) => (
  <Square size={size} fill="currentColor" strokeWidth={0} aria-hidden="true" {...(props as LucideProps)} />
)

export const SquareIcon = wrap(Square)

export const SpinnerIcon = wrap(LoaderCircle)
export const QuestionIcon = wrap(CircleHelp)
export const PuzzleIcon = wrap(Puzzle)
export const PathAutoIcon = wrap(Sun)
export const PathUnixIcon = wrap(Slash)

export const PathWindowsIcon = ({ size = 16, style, ...props }: IconProps) => (
  <Slash size={size} aria-hidden="true" style={{ transform: 'scaleX(-1)', ...style }} {...(props as LucideProps)} />
)

export const PatchIcon = wrap(FileDiff)
export const GitWorktreeIcon = wrap(Waypoints)
export const GitDiffIcon = wrap(GitCompare)
export const PermissionListIcon = wrap(ListTodo)
export const ListFilterIcon = wrap(ListFilter)
export const LayersIcon = wrap(Layers)
export const MinusIcon = wrap(Minus)
export const PaperclipIcon = wrap(Paperclip)
export const FastForwardIcon = wrap(FastForward)
export const VolumeIcon = wrap(Volume2)
export const VolumeOffIcon = wrap(VolumeX)
export const PlayIcon = wrap(Play)
export const PauseIcon = wrap(Pause)
export const TargetIcon = wrap(Target)
export const UploadIcon = wrap(Upload)
export const ShieldIcon = wrap(Shield)
export const SplitHorizontalIcon = wrap(Columns2)
export const SplitVerticalIcon = wrap(Rows2)
export const GripVerticalIcon = wrap(GripVertical)
export const MoreVerticalIcon = wrap(EllipsisVertical)
export const AppWindowIcon = wrap(AppWindow)

/** DeepSeek 标志：实心单路径，颜色跟随 currentColor。DS 远程通道用它。 */
export const DeepSeekIcon = ({ size = 16, ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
    <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
  </svg>
)
