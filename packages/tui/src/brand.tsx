import { Box, Text } from "ink";
import { theme } from "./theme.ts";

const left = ["▄▀▀▄ █▄ ▄█ █▀▀█", "█  █ █ █ █ █▄▄█", "▀▄▄▀ █   █ █   "];
const right = ["▀ █  █ ▀█▀", "█ █  █  █ ", "█ ▀▄▄▀ ▄█▄"];

export function Wordmark() {
  return (
    <Box flexDirection="column" width={26} flexShrink={0} aria-label="OMPiUI">
      {left.map((line, index) => (
        <Text key={index}>
          <Text color={theme.muted}>{line}</Text>{" "}
          <Text color={theme.text} bold>
            {right[index]}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
