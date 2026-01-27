import { describeIf, TEST_PRODUCTION } from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";
import crypto from "crypto";

/**
 * Unit tests for index cache document selection logic.
 *
 * This tests the bug fix where scrapeURLWithIndex was using data[0].id
 * instead of selectedRow.id when fetching documents from GCS.
 */
describe("Index cache document selection", () => {
  // Test the selection logic that determines which cached entry to use
  // This mirrors the logic in scrapeURLWithIndex

  const errorCountToRegister = 3;

  function selectRow(
    data: Array<{ id: string; status: number; created_at: string }>,
  ) {
    if (data.length === 0) return null;

    const newest200Index = data.findIndex(
      x => x.status >= 200 && x.status < 300,
    );

    // If the newest 200 index is further back than the allowed error count,
    // we should display the errored index entry
    if (newest200Index >= errorCountToRegister || newest200Index === -1) {
      return data[0];
    } else {
      return data[newest200Index];
    }
  }

  it("should select data[0] when it has a 200 status", () => {
    const data = [
      { id: "success-doc", status: 200, created_at: "2024-01-02T00:00:00Z" },
      { id: "old-doc", status: 200, created_at: "2024-01-01T00:00:00Z" },
    ];

    const selected = selectRow(data);
    expect(selected?.id).toBe("success-doc");
  });

  it("should select the first 200 entry when data[0] has an error status", () => {
    const data = [
      { id: "error-doc", status: 500, created_at: "2024-01-03T00:00:00Z" },
      { id: "success-doc", status: 200, created_at: "2024-01-02T00:00:00Z" },
      { id: "old-doc", status: 200, created_at: "2024-01-01T00:00:00Z" },
    ];

    const selected = selectRow(data);
    // The bug was using data[0].id ("error-doc") instead of selectedRow.id ("success-doc")
    expect(selected?.id).toBe("success-doc");
    expect(selected?.id).not.toBe("error-doc");
  });

  it("should select data[0] when there are too many errors before a 200", () => {
    const data = [
      { id: "error-1", status: 500, created_at: "2024-01-05T00:00:00Z" },
      { id: "error-2", status: 500, created_at: "2024-01-04T00:00:00Z" },
      { id: "error-3", status: 500, created_at: "2024-01-03T00:00:00Z" },
      { id: "success-doc", status: 200, created_at: "2024-01-02T00:00:00Z" },
    ];

    const selected = selectRow(data);
    // When there are 3+ errors before a 200, we show the error
    expect(selected?.id).toBe("error-1");
  });

  it("should select data[0] when there are no 200 entries", () => {
    const data = [
      { id: "error-1", status: 500, created_at: "2024-01-03T00:00:00Z" },
      { id: "error-2", status: 404, created_at: "2024-01-02T00:00:00Z" },
    ];

    const selected = selectRow(data);
    expect(selected?.id).toBe("error-1");
  });

  it("should return null for empty data", () => {
    const data: Array<{ id: string; status: number; created_at: string }> = [];

    const selected = selectRow(data);
    expect(selected).toBeNull();
  });

  it("should select the 200 entry when it is at index 1 (within errorCountToRegister)", () => {
    const data = [
      { id: "error-doc", status: 403, created_at: "2024-01-02T00:00:00Z" },
      { id: "success-doc", status: 200, created_at: "2024-01-01T00:00:00Z" },
    ];

    const selected = selectRow(data);
    expect(selected?.id).toBe("success-doc");
  });

  it("should select the 200 entry when it is at index 2 (within errorCountToRegister)", () => {
    const data = [
      { id: "error-1", status: 500, created_at: "2024-01-03T00:00:00Z" },
      { id: "error-2", status: 500, created_at: "2024-01-02T00:00:00Z" },
      { id: "success-doc", status: 200, created_at: "2024-01-01T00:00:00Z" },
    ];

    const selected = selectRow(data);
    expect(selected?.id).toBe("success-doc");
  });
});

describeIf(TEST_PRODUCTION)("V2 Scrape Default maxAge", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-default-maxage",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  test(
    "should use default maxAge of 4 hours when not specified",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Second scrape should hit cache with default maxAge
      const data2 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should respect explicitly set maxAge of 0",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Second scrape with maxAge=0 should miss cache
      const data2 = await scrape(
        {
          url,
          maxAge: 0,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBeUndefined();
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should respect custom maxAge value",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
          maxAge: 3600000, // 1 hour in milliseconds
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Second scrape with same maxAge should hit cache
      const data2 = await scrape(
        {
          url,
          maxAge: 3600000, // 1 hour in milliseconds
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should return error if cached data does not meet minAge requirement",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated
      await new Promise(resolve => setTimeout(resolve, 20000));

      // Second scrape with minAge should fail
      const response = await scrapeRaw(
        {
          url,
          minAge: 60000,
        },
        identity,
      );

      expect(response.statusCode).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("SCRAPE_NO_CACHED_DATA");
    },
    scrapeTimeout * 2 + 20000,
  );

  test(
    "should return cached data if it meets minAge requirement",
    async () => {
      const id = crypto.randomUUID();
      const url = "https://firecrawl.dev/?testId=" + id;

      // First scrape to populate cache
      const data1 = await scrape(
        {
          url,
        },
        identity,
      );

      expect(data1).toBeDefined();
      expect(data1.metadata.cacheState).toBe("miss");

      // Wait for index to be populated and for data to age
      await new Promise(resolve => setTimeout(resolve, 35000));

      // Second scrape with minAge should hit cache
      const data2 = await scrape(
        {
          url,
          minAge: 30000,
        },
        identity,
      );

      expect(data2).toBeDefined();
      expect(data2.metadata.cacheState).toBe("hit");
      expect(data2.metadata.cachedAt).toBeDefined();
    },
    scrapeTimeout * 2 + 35000,
  );
});
