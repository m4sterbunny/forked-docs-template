import { useOnChange } from "../utils/use-on-change.js";
import { use, useEffect, useRef, useState } from "react";
//#region src/utils/use-debounce.ts
function useDebounce(value, delayMs = 1e3) {
	const [debouncedValue, setDebouncedValue] = useState(value);
	useEffect(() => {
		if (delayMs === 0) return;
		const handler = window.setTimeout(() => {
			setDebouncedValue(value);
		}, delayMs);
		return () => clearTimeout(handler);
	}, [delayMs, value]);
	if (delayMs === 0) return value;
	return debouncedValue;
}
//#endregion
//#region src/search/client.ts
const promiseMap = {};
/**
* Provide a hook to query different official search clients.
*
* Note: it will re-query when its parameters changed, make sure to define `deps` array if you encounter rendering issues.
*/
function useDocsSearch(clientOptions, deps) {
	const { delayMs = 100, allowEmpty = false, ...clientRest } = clientOptions;
	const [search, setSearch] = useState("");
	const [results, setResults] = useState("empty");
	const [error, setError] = useState();
	const [isLoading, setIsLoading] = useState(false);
	const debouncedValue = useDebounce(search, delayMs);
	const onStart = useRef(void 0);
	let client;
	if ("type" in clientRest) switch (clientRest.type) {
		case "fetch": {
			const { fetchClient } = use(promiseMap[clientRest.type] ??= import("./client/fetch.js"));
			client = fetchClient(clientRest);
			break;
		}
		case "algolia": {
			const { algoliaClient } = use(promiseMap[clientRest.type] ??= import("./client/algolia.js"));
			client = algoliaClient(clientRest);
			break;
		}
		case "orama-cloud": {
			const { oramaCloudClient } = use(promiseMap[clientRest.type] ??= import("./client/orama-cloud.js"));
			client = oramaCloudClient(clientRest);
			break;
		}
		case "orama-cloud-legacy": {
			const { oramaCloudLegacyClient } = use(promiseMap[clientRest.type] ??= import("./client/orama-cloud-legacy.js"));
			client = oramaCloudLegacyClient(clientRest);
			break;
		}
		case "mixedbread": {
			const { mixedbreadClient } = use(promiseMap[clientRest.type] ??= import("./client/mixedbread.js"));
			client = mixedbreadClient(clientRest);
			break;
		}
		case "static": {
			const { oramaStaticClient } = use(promiseMap[clientRest.type] ??= import("./client/orama-static.js"));
			client = oramaStaticClient(clientRest);
			break;
		}
		default: throw new Error("unknown search client");
	}
	else client = clientRest.client;
	useOnChange([deps ?? client.deps, debouncedValue], () => {
		if (onStart.current) {
			onStart.current();
			onStart.current = void 0;
		}
		setIsLoading(true);
		let interrupt = false;
		onStart.current = () => {
			interrupt = true;
		};
		async function run() {
			if (debouncedValue.length === 0 && !allowEmpty) return "empty";
			return client.search(debouncedValue);
		}
		run().then((res) => {
			if (interrupt) return;
			setError(void 0);
			setResults(res);
		}).catch((err) => {
			setError(err);
		}).finally(() => {
			setIsLoading(false);
		});
	});
	return {
		search,
		setSearch,
		query: {
			isLoading,
			data: results,
			error
		}
	};
}
//#endregion
export { useDocsSearch };
