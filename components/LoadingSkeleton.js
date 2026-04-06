export default function LoadingSkeleton({ height = "h-40", className = "" }) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded-lg ${height} ${className}`}>
      <div className="h-full w-full flex items-center justify-center">
        <div className="space-y-3 w-3/4">
          <div className="h-3 bg-gray-300 rounded w-full" />
          <div className="h-3 bg-gray-300 rounded w-5/6" />
          <div className="h-3 bg-gray-300 rounded w-4/6" />
        </div>
      </div>
    </div>
  );
}
