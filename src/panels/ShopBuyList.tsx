import type { SnapshotShopGood } from '../protocol/index';
import { numOrUnknown, UNKNOWN_TEXT } from './questCardModel';

interface ShopBuyListProps {
  goods: SnapshotShopGood[];
  running: boolean;
  onBuy: (good: SnapshotShopGood) => void;
}

export function ShopBuyList({ goods, running, onBuy }: ShopBuyListProps) {
  return (
    <div className="items">
      {goods.slice(0, 60).map(g => (
        <button
          key={g.itemId}
          type="button"
          className="item"
          data-testid="shop-buy"
          data-item-id={String(g.itemId)}
          disabled={!running}
          onClick={() => onBuy(g)}
        >
          {`買 ${g.name ?? `#${g.itemId}`}`}
          <small>{g.pricePlaceholder === true ? UNKNOWN_TEXT : numOrUnknown(g.price, n => `${n} 金`)}</small>
        </button>
      ))}
    </div>
  );
}
