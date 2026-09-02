import { search } from "./research/search.js";

const QUERY = "Mercedes C240 W203 P0305 misfire cylinder 5";

// Run the current diagnostic search query and print the returned sources.
async function main() {
  console.log("AutoTrace Research Agent");
  console.log("========================");
  console.log(`Research query: ${QUERY}\n`);

  const results = await search(QUERY);

  console.log("Search Results:\n");

  if (results.length === 0) {
    console.log("No search results found.");
  } else {
    for (const [index, result] of results.entries()) {
      console.log(`${index + 1}. ${result.title}`);
      console.log(`   URL: ${result.url}\n`);
    }
  }
}

main().catch((error) => {
  console.error("AutoTrace failed:", error);
  process.exit(1);
});
